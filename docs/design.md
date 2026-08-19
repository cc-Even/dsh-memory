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

Every add first commits a recallable L1 raw record and an `accepted` job. Direct mode then creates one L2 fact or L4 identity. Extraction mode sends untrusted conversation JSON to the configured model, accepts only an exact schema-valid JSON object, pre-filters same-owner reconciliation candidates, and requires a plan that covers every extracted source exactly once.

`ADD` creates a new chain head. `NOOP` attaches the new raw record as additional evidence to the existing record. `CONSOLIDATE` creates a combined head and supersedes its targets. `SUPERSEDE` creates a new revision and preserves reverse links. Successful processing changes raw evidence to `source_only`; model or parsing failure marks the job `degraded` and leaves raw L1 recallable. A restart changes interrupted `accepted` jobs to `degraded` without guessing that enrichment completed.

The reference provider writes L0 basic profile, L1 raw, L2 fact, L3 summary, and L4 identity records. L5-L7 stay reserved in the public type vocabulary and fail closed on write or import.

### Retrieval and model visibility

Reads pre-filter owner, status, visibility, validity, requested layers, and optional Session before ranking. Profile and normal channels have independent quotas. The portable provider combines a versioned 256-dimensional token/character hash vector, BM25, and reciprocal-rank fusion; diagnostics identify the hash vector as degraded semantic retrieval and report the missing independent tag channel.

Automatic recall runs after the normal `agent/pre-step` decision and prepends one plugin-authored user message only when that decision contains direct human input and retrieval returns records. The message is bounded, delimited, labels records as fallible, and enters the ordinary Session surface before the model request. Automatic capture runs at `agent/turn-stopping`, excludes tools and the plugin's own recall message, and uses `{sessionId}:turn:{turn}` as its idempotency key.

The tool consumer never accepts scope identifiers from the model. It exposes direct writes only, keeps bulk import/export trusted-only, and requires an exact record id for forgetting.

## Verification

Package tests use the real LLM runtime, storage hub, storage-domain form, and JSON backend. They cover direct raw-first idempotency, cross-session versus Session-only retrieval, degraded extraction, strict successful extraction plus duplicate evidence, evidence-aware forgetting, and the four tool contracts. A real Loader composition writes through the JSON backend, fully disposes, starts a cold composition, and recalls the prior Session's record.

The package builds the service, tool, and invariant as independent exports. The invariant validates stored memory-domain changes for deleted visibility, unique active chain heads, and bidirectional evolution relations.

## Alternatives considered

**Store memory in the Session log or a Session projection.** This naturally isolates each Session and cannot provide the required cross-session owner corpus without a second index and identity policy. Session ids remain provenance instead.

**Make memory tools own the store.** Automatic capture, host consumers, migration, and future UI consumers need a stable non-model capability. The tools remain a narrow optional consumer.

**Require a concrete embedding service.** Harness has no embedding capability today, and binding this package to an LLM vendor would violate the provider seam. The portable hash space ships with explicit diagnostics and import compatibility checks.

**Hide raw records after accepting a write.** A model or process failure between acceptance and enrichment would lose recallability. Raw evidence remains recallable until a successful direct or extracted commit.

## Consequences

Harness gains auditable cross-session memory without a second lifecycle, model adapter, or backend abstraction. Deployments can mount automatic recall/capture, explicit tools, both, or only the trusted service API. Model failures preserve evidence and return a visible degraded receipt; changing facts remain inspectable through evolution links rather than destructive overwrite.

The reference store favors correctness and portability over scale: owner state is a whole JSON row, semantic vectors are approximate, and concurrency serialization is process-local. A paged transactional provider, trained embeddings, native structured output, authenticated subject mapping, retention policy, and L5-L7 semantics remain separate future decisions.
