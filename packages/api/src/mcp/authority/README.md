# MCP authority proof rollout

This module is an additive, default-off substrate. Existing MCP catalog, OAuth, connection, and
tool-call paths do not invoke it yet. A caller creates one `MCPAuthorityProofResolver` per immutable
boot configuration, resolves selected servers into an authority proof, and carries that proof with
the parsed configuration and schemas. Fence helpers accept only the resolution envelope issued by
that resolver, verify its artifact revision, and pass that exact envelope to the publication,
binding, or execution callback. They do not accept a detached proof with arbitrary artifacts, and
the resolver never freezes or otherwise mutates caller-owned config and schema objects.

Every selected target must carry the source generation captured by the parser that produced its
resolved config. Database targets use `createMCPAuthorityDatabaseSourceRevision`; config targets use
`createMCPAuthorityConfigSourceRevision` with the boot digest and the parser's complete applicable
Config document set, including inactive documents. Targets also carry the exact credential revision
from `createMCPAuthorityCredentialRevision` and the expected OAuth `credential_set_id` generation
(or `null`). The primary-backed resolve rejects when any generation is no longer current, closing
the parse-before-proof and credential-rotation windows. `calculateArtifactRevision` must canonically
cover the actual parsed config and schema identities; the resolver combines it with target names,
source generations, config digests, credential fields, and OAuth requirements, then checks it on
both sides of every awaited final assertion. This callback exists because real parsed tool
artifacts can contain functions and class instances that a generic JSON hasher cannot safely
canonicalize.

The boot digest is computed once by the resolver constructor. A current-authority assertion never
reloads YAML, calls the MCP registry, scans Redis, initializes a server, or performs network I/O. It
opens a fresh primary/snapshot Mongo transaction with majority read and write concerns, and batches
bounded operations per mutable collection, independent of the number of selected servers. Finds use
`singleBatch` plus a same-snapshot count equality check, while aggregations collapse their bounded
rows into one result document. An oversized, truncated, or malformed tenant fails closed without a
`getMore` inside a DocumentDB transaction.

## Integration fences

AI-1715 can adopt the substrate behind its existing default-off rollout gate:

- Use `publishWithCurrentAuthority` immediately around catalog, schema, HTTP response, and binding
  publication callbacks.
- Use `executeWithCurrentAuthority` around the remote `tools/call` callback, after connection,
  OAuth, Graph, and OBO work. The optional `beforeExecute` hook exists for deterministic race tests;
  the authoritative assertion runs after the hook and immediately before the callback.
- OAuth callback integration must assert before token exchange. After exact-generation storage,
  re-resolve a new proof bound to that stored generation, then assert the new proof immediately
  before waking waiters. The pre-store proof is expected to reject once the grant exists and must
  never be reused. If re-resolution or the post-store assertion rejects, delete only the credential
  generation written by that callback.
- Validate that the route server name, parsed flow-id server name, and stored flow-state server name
  are identical before resolving or asserting a proof.

Do not enable scoped catalog behavior merely by constructing this resolver. The caller owns the
feature gate and must carry the same proof through each final fence.

Before enabling that gate, run `backfillMCPServerNormalizedNames` while MCP server writes are
quiesced, then run `createMCPAuthorityLookupIndexes`. Resolve every collision reported by the
name migration before retrying; do not enable proofs until both migrations complete. These are
offline rollout steps and are never invoked by a hot proof path.

## Observability

`MCPAuthorityProofError.reason` is a bounded rejection code suitable for a counter or structured
log field. Log the reason, fence name, and optional server name. Do not log the proof, resolved
configuration, credential digests, OAuth generation, user source identifiers, or underlying query
error. Unexpected database and malformed-record failures are normalized to `proof_unavailable` so
the path fails closed without exposing stored data.
