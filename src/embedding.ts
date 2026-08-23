/** Pluggable embedding providers used by durable-memory writes and retrieval. */

import { MemoryError } from './error.ts'
import {
  HASH_EMBEDDING_DIMENSIONS,
  HASH_EMBEDDING_SPACE_ID,
  hashEmbedding,
} from './retrieval.ts'

/** Non-secret facts that identify one immutable embedding space. */
export interface EmbeddingDescription {
  readonly spaceId: string
  readonly dimensions: number
  readonly maxBatchSize: number
  readonly normalization: 'l2'
  readonly quality: 'portable-hash' | 'trained'
}

/** Provider port. The memory core owns batching, validation, and final normalization. */
export abstract class EmbeddingProvider {
  abstract describe(): EmbeddingDescription
  abstract embedBatch(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]>
}

/** Deterministic offline provider preserving the original portable hash space. */
export class HashEmbeddingProvider extends EmbeddingProvider {
  describe(): EmbeddingDescription {
    return {
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      maxBatchSize: 256,
      normalization: 'l2',
      quality: 'portable-hash',
    }
  }

  async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map(hashEmbedding)
  }
}

/** Construction options for the OpenAI-compatible remote adapter. */
export interface OpenAICompatibleEmbeddingOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly spaceId: string
  readonly dimensions: number
  readonly batchSize?: number
  readonly timeoutMs?: number
  readonly maxRetries?: number
  readonly retryBaseDelayMs?: number
}

const DEFAULT_BATCH_SIZE = 128
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 100

/** OpenAI-compatible `/embeddings` adapter with bounded retry and redacted errors. */
export class OpenAICompatibleEmbeddingProvider extends EmbeddingProvider {
  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #model: string
  readonly #description: EmbeddingDescription
  readonly #timeoutMs: number
  readonly #maxRetries: number
  readonly #retryBaseDelayMs: number

  constructor(options: OpenAICompatibleEmbeddingOptions) {
    super()
    this.#baseUrl = validatedBaseUrl(options.baseUrl)
    this.#apiKey = nonEmpty(options.apiKey, 'apiKey')
    this.#model = nonEmpty(options.model, 'model')
    const dimensions = boundedInteger(options.dimensions, 1, 65_536, 'dimensions')
    this.#description = Object.freeze({
      spaceId: nonEmpty(options.spaceId, 'spaceId'),
      dimensions,
      maxBatchSize: boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 1, 2_048, 'batchSize'),
      normalization: 'l2',
      quality: 'trained',
    })
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 300_000, 'timeoutMs')
    this.#maxRetries = boundedInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, 0, 10, 'maxRetries')
    this.#retryBaseDelayMs = boundedInteger(
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      1,
      60_000,
      'retryBaseDelayMs',
    )
  }

  describe(): EmbeddingDescription {
    return this.#description
  }

  async embedBatch(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return []
    throwIfAborted(signal)
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      try {
        const result = await this.#attempt(texts, signal)
        throwIfAborted(signal)
        return result
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
        const retryable = error instanceof RetryableEmbeddingFailure
        if (!retryable || attempt === this.#maxRetries) {
          throw new MemoryError('EMBEDDING_FAILED', 'embedding provider request failed')
        }
        await abortableDelay(this.#retryBaseDelayMs * 2 ** attempt, signal)
      }
    }
    throw new MemoryError('EMBEDDING_FAILED', 'embedding provider request failed')
  }

  async #attempt(
    texts: readonly string[],
    callerSignal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    const controller = new AbortController()
    const timeoutReason = new TimeoutEmbeddingFailure()
    const timer = setTimeout(() => controller.abort(timeoutReason), this.#timeoutMs)
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason)
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    try {
      let response: Response
      try {
        response = await fetch(`${this.#baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.#model,
            input: texts,
            dimensions: this.#description.dimensions,
            encoding_format: 'float',
          }),
          signal: controller.signal,
        })
      } catch (error) {
        if (callerSignal?.aborted) throw callerSignal.reason ?? error
        if (controller.signal.aborted && controller.signal.reason === timeoutReason) throw timeoutReason
        throw new RetryableEmbeddingFailure()
      }
      if (!response.ok) {
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          throw new RetryableEmbeddingFailure()
        }
        throw new PermanentEmbeddingFailure()
      }
      let value: unknown
      try {
        value = await response.json()
      } catch (error) {
        if (callerSignal?.aborted) throw callerSignal.reason ?? error
        if (controller.signal.aborted && controller.signal.reason === timeoutReason) throw timeoutReason
        throw new PermanentEmbeddingFailure()
      }
      return parseEmbeddingResponse(value, texts.length, this.#description.dimensions)
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }
}

class RetryableEmbeddingFailure extends Error {}
class TimeoutEmbeddingFailure extends RetryableEmbeddingFailure {}
class PermanentEmbeddingFailure extends Error {}

function parseEmbeddingResponse(
  value: unknown,
  count: number,
  dimensions: number,
): readonly (readonly number[])[] {
  if (value === null || typeof value !== 'object') throw new PermanentEmbeddingFailure()
  const data = (value as { readonly data?: unknown }).data
  if (!Array.isArray(data) || data.length !== count) throw new PermanentEmbeddingFailure()
  const ordered: Array<readonly number[] | undefined> = Array(count).fill(undefined)
  for (const item of data) {
    if (item === null || typeof item !== 'object') throw new PermanentEmbeddingFailure()
    const { index, embedding } = item as { readonly index?: unknown; readonly embedding?: unknown }
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= count) {
      throw new PermanentEmbeddingFailure()
    }
    if (ordered[index as number] !== undefined || !Array.isArray(embedding) || embedding.length !== dimensions) {
      throw new PermanentEmbeddingFailure()
    }
    if (!embedding.every(entry => typeof entry === 'number' && Number.isFinite(entry))) {
      throw new PermanentEmbeddingFailure()
    }
    ordered[index as number] = embedding as number[]
  }
  if (ordered.some(vector => vector === undefined)) throw new PermanentEmbeddingFailure()
  return ordered as readonly (readonly number[])[]
}

function validatedBaseUrl(value: unknown): string {
  const text = nonEmpty(value, 'baseUrl').replace(/\/+$/u, '')
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
  } catch {
    throw new MemoryError('EMBEDDING_FAILED', 'embedding provider baseUrl is invalid')
  }
  return text
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryError('EMBEDDING_FAILED', `embedding provider ${field} must be non-empty`)
  }
  return value.trim()
}

function boundedInteger(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new MemoryError(
      'EMBEDDING_FAILED',
      `embedding provider ${field} must be an integer from ${minimum} through ${maximum}`,
    )
  }
  return value as number
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('embedding operation aborted')
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new Error('embedding operation aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
