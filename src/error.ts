/** Stable failures raised by the memory capability. */

/** Public memory failure codes. */
export type MemoryErrorCode =
  | 'INVALID_INPUT'
  | 'SCOPE_REQUIRED'
  | 'RAW_PERSIST_FAILED'
  | 'EXTRACTION_FAILED'
  | 'RECONCILE_FAILED'
  | 'CONCURRENT_MODIFICATION'
  | 'EMBEDDING_SPACE_MISMATCH'
  | 'STORE_UNAVAILABLE'

/** Error whose code is safe for consumers to branch on. */
export class MemoryError extends Error {
  override readonly name = 'MemoryError'

  /**
   * @param code - Stable failure classification.
   * @param message - Human-readable diagnostic.
   * @param options - Standard error options.
   */
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
