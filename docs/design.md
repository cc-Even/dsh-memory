# Durable memory design

English | [中文](design.zh.md)

## Problem

Harness Sessions preserve an exact conversation log, but they do not provide a user/agent memory that survives Session boundaries. The memory service must use the existing Harness ownership of LLM routing, lifecycle, storage, and turn events while adopting the correct identity and retention boundary. It must preserve raw evidence before fallible enrichment, keep changing facts auditable, isolate owners before retrieval, and make every model-visible recall reconstructable from the Session log.

Session compaction and cross-session memory serve different retention needs. Compaction retains exact in-session history, while memory retains selected durable user facts and identities across Sessions.

## Decision

`@evyn/dsh-memory` contains a capability service and an optional tool consumer:

- the package root mounts `ctx.memory` and owns durable scope state, model extraction and reconciliation, hybrid retrieval, soft deletion, import/export, and optional turn hooks;
- the `/tool` export registers explicit add, search, list, and forget tools, and derives every scope from the live owning Agent.

The service depends only on the Harness `agents`, `llm`, and `storageDomain` seams. It combines definition and reference provider while the contract is new and has one implementation; the tool entry remains separate because model authority is optional and materially narrower than the trusted service API.

### Scope and durable state

The storage key is `{tenantId,userId,agentId}`. `sessionId` is record provenance and an optional read filter, not the storage partition, so a new Session can recall earlier records. `userId` defaults to the stable anonymous Harness-home identity, `agentId` comes from the Agent preset or `default`, and neither default is an authentication boundary.

One storage-domain row contains an owner revision, records, and durable write receipts. Every mutation replaces that row atomically. A per-owner queue serializes one service instance, closes admission during disposal, and drains admitted writes before closing the domain.

### Raw-first enrichment and evolution

Every add first commits a recallable L1 raw record and an `accepted` job. Direct mode then creates one L2 fact or L4 identity. Extraction mode sends untrusted conversation JSON to the configured model and accepts only an exact schema-valid JSON object. Each sanitized source independently ranks active, recallable, currently valid same-layer records from the owner row; Session is not a reconciliation boundary. Empty shortlists become deterministic `ADD` operations, while the model sees only non-empty sources and must cover each of those exactly once. In a trained remote embedding space, the first raw commit carries a same-space, same-dimension zero placeholder so no fallible network call can precede durable evidence. A successful commit replaces placeholders with validated, L2-normalized vectors; embedding failure degrades the job without derived records and leaves L1 lexically recallable.

`ADD` creates a new chain head. `NOOP` attaches the new raw record as additional evidence to the existing record. `CONSOLIDATE` creates a combined head and supersedes its targets. `SUPERSEDE` creates a new revision and preserves reverse links. Successful processing changes raw evidence to `source_only`; model or parsing failure marks the job `degraded` and leaves raw L1 recallable. A restart changes interrupted `accepted` jobs to `degraded` without guessing that enrichment completed.

The reference provider writes L0 basic profile, L1 raw, L2 fact, L3 summary, and L4 identity records. L5-L7 stay reserved in the public type vocabulary and fail closed on write or import.

### Retrieval and model visibility

Reads pre-filter owner, status, visibility, validity, requested layers, and optional Session before any provider call or ranking. Profile and normal channels have independent quotas. `EmbeddingProvider` exposes a non-secret immutable descriptor and batch embedding operation. The core performs sequential bounded batching, count/dimension/finite/non-zero validation, order preservation, and final L2 normalization. The default `HashEmbeddingProvider` preserves the versioned 256-dimensional token/character hash vectors byte-for-byte. The trained reference adapter calls an OpenAI-compatible endpoint with bounded per-attempt timeout, retry, and backoff; credentials come from a named environment variable in loader configuration and never enter descriptors or public configuration.

Semantic vectors, BM25, and reciprocal-rank fusion remain independent channels. A trained-provider search outage closes only the semantic channel, returns lexical results with `semantic:provider-unavailable`, and never converts caller cancellation into fallback success. Reconciliation embeds source queries in ordered batches bounded by the provider descriptor. A non-cancellation failure, invalid output, or zero vector disables semantic ranking only for that batch and does not stop later batches; tokenizer failure is isolated per source. A source may proceed through either remaining channel, but if any non-empty candidate pool loses both channels, the entire accepted job degrades without partial derived records. Failure while embedding final derived records also degrades the whole enrichment under raw-first semantics. Portable hash searches continue to report `semantic:portable-hash`.

BM25 uses a public `LexicalTokenizer` seam. The default `CjkBigramTokenizer` preserves ASCII alphanumeric runs and emits overlapping bigrams for contiguous Basic Han; `legacy` restores the prior whole-Han-run policy as a storage-neutral rollback. The portable hash space is isolated behind its own private legacy token path, so lexical policy changes never mutate its versioned vectors. One resolved tokenizer is shared by profile/normal ranking, trained-provider lexical fallback, degraded zero-placeholder raw recall, and reconciliation candidates. Query length and all owner/status/visibility/validity/layer/Session filters run before either tokenizer or provider; an empty candidate set short-circuits both.

Trusted programmatic tokenizers receive only the query plus pre-filtered candidate content and normalized tags. Empty-input preflight, actual-array checks, 100,000-token and 256-UTF-16-unit limits, immediate copying, and fixed `TOKENIZATION_FAILED` errors bound ordinary failures without retaining an upstream cause. Search closes only lexical ranking and emits `lexical:tokenizer-unavailable`; if semantic also fails, it returns empty channels with both diagnostics. Reconciliation may use lexical alone; semantic-only fallback additionally requires a non-zero query vector and at least one non-zero candidate vector. Without that signal it degrades the accepted job and preserves recallable L1. The reconciliation prompt contains sources in extraction order with their own ranked candidate IDs plus a stable first-seen deduplicated candidate catalog. `NOOP` and `SUPERSEDE` targets must belong to that source's shortlist; `CONSOLIDATE` may use only the union of its participating same-layer sources. Auto-`ADD` sources and all owner, Session, vector, metadata, visibility, invalid-state, and out-of-layer material remain model-invisible. Caller abort remains an abort. Because the extension is synchronous, a trusted implementation that never returns cannot be preempted at this boundary.

An owner state is valid only when every record matches the active descriptor's `spaceId` and dimensions. Import, cold startup, and mixed batches reject mismatches atomically. Provider, model, dimensions, normalization, or algorithm changes require a new deployment-fixed space ID. MEM-101 deliberately does not rewrite canonical records; re-embedding and migration belong to MEM-104.

Automatic recall runs after the normal `agent/pre-step` decision and prepends one plugin-authored user message only when that decision contains direct human input and retrieval returns records. The message is bounded, delimited, labels records as fallible, and enters the ordinary Session surface before the model request. Automatic capture runs at `agent/turn-stopping`, excludes tools and the plugin's own recall message, and uses `{sessionId}:turn:{turn}` as its idempotency key.

The tool consumer never accepts scope identifiers from the model. It exposes direct writes only, keeps bulk import/export trusted-only, and requires an exact record id for forgetting.

## Verification

Package tests use the real LLM runtime, storage hub, storage-domain form, and JSON backend. They cover direct raw-first idempotency, cross-session versus Session-only retrieval, degraded extraction, strict successful extraction plus duplicate evidence, evidence-aware forgetting, provider batching/normalization/retry/cancellation/redaction, trained-provider degradation and space isolation, and the four tool contracts. A real Loader composition writes through the JSON backend, fully disposes, starts a cold composition, and recalls the prior Session's record.

The offline embedding evaluator uses the built package, temporary JSON storage, and public `import()`/`search()` APIs over a frozen bilingual low-overlap corpus. It performs no network access and fixes the hash baseline. Live evaluation requires both a model flag and explicit network authorization, reads endpoint/key from the environment, and emits only non-secret provider facts, aggregate/case metrics, and isolation hard checks.

The offline lexical evaluator materializes a frozen 258-record Chinese corpus through the same public API in fresh contexts, comparing explicit `legacy` and default `cjk-bigram` modes with the identical hash space. Its canonical report includes 24 scored cases, six isolation negatives, per-bucket Recall@5/10 and MRR@10, mode deltas, tokenizer provenance, and zero-tolerance hard checks. The embedding evaluator explicitly selects `legacy` so MEM-101 quality remains isolated from lexical-policy changes.

The package builds the service, tool, and invariant as independent exports. The invariant validates stored memory-domain changes for deleted visibility, unique active chain heads, and bidirectional evolution relations.

## Alternatives considered

**Store memory in the Session log or a Session projection.** This naturally isolates each Session and cannot provide the required cross-session owner corpus without a second index and identity policy. Session ids remain provenance instead.

**Make memory tools own the store.** Automatic capture, host consumers, migration, and future UI consumers need a stable non-model capability. The tools remain a narrow optional consumer.

**Require one concrete embedding service.** Harness has no shared embedding capability today, and binding the package to one vendor would violate the provider seam. The package instead owns a narrow provider port, keeps the portable hash implementation as its offline default, and supplies one OpenAI-compatible production adapter.

**Hide raw records after accepting a write.** A model or process failure between acceptance and enrichment would lose recallability. Raw evidence remains recallable until a successful direct or extracted commit.

## Consequences

Harness gains auditable cross-session memory without a second lifecycle, model adapter, or backend abstraction. Deployments can mount automatic recall/capture, explicit tools, both, or only the trusted service API. Model failures preserve evidence and return a visible degraded receipt; changing facts remain inspectable through evolution links rather than destructive overwrite.

The reference store favors correctness and portability over scale: owner state is a whole JSON row and concurrency serialization is process-local. A trained provider can improve low-overlap semantic recall, but sends memory text to an external data processor and introduces latency and availability risk; raw-first and lexical fallback bound those failures. A paged transactional store, embedding-space migration, native structured output, authenticated subject mapping, retention policy, and L5-L7 semantics remain separate future decisions.
