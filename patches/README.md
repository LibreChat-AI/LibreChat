# Temporary agents SDK bridge

This development bridge adds an injected `NativeMediaPort`, provider-neutral usage-bearing errors, structured native content, and the high-level `traceModelInvocation` API to the published `@librechat/agents` 4.0.1 package. The SDK owns model execution and tracing lifecycle. The host authorizes native generation, saves ordinary `image_generation` Files, and restores private signatures from assistant Message metadata before replay. New native chat output does not depend on Studio jobs or threads.

The published 4.0.1 package does not contain `NativeMediaPort`, `UsageBearingError` or `traceModelInvocation`. The upstream work is in [LibreChat-AI/agents#553](https://github.com/LibreChat-AI/agents/pull/553), rebased onto the SDK's 4.0.1 release, and the patch is generated from that branch. This bridge remains necessary until the SDK contracts are merged, published, and consumed here.

Both consumers pin exactly 4.0.1, the release `dev` targets, because the patch applies only to that published layout. Root `postinstall` applies `patch-package --error-on-fail`; container builds copy the patch before installation, and dependency/build cache keys include its content. The patch contains production source and matching CommonJS, ESM and declaration artifacts because the application loads the published package layout.

The internal Langfuse span-capture hunks preserve the generation span associated with a callback so failure usage is recorded on the correct tenant/model observation. They support the provider-neutral `UsageBearingError`; they do not add a host-facing raw handler API. The high-level tracing lifecycle and this internal failure-usage behavior are covered by the SDK tracing suites and documented in its design records.

Google streaming forwards the request AbortSignal to the provider and observes the companion aggregate-response promise immediately. The consumed stream remains responsible for reporting failures; cancellation closes the provider connection without a later unhandled rejection. Real socket cancellation and provider-disconnect regressions cover this lifecycle.

`npm run test:agents-contract` runs the repository-owned `config/native-media-contract.test.mjs` against the installed package. It covers CJS/ESM invocation, streaming/event paths, image admission, signed replay, provider blocking, failure usage and the public tracing lifecycle. The SDK has its own repository-owned contract gate; neither fixture is included in its npm package. The existing backend review CI runs the installed-package contract. Studio's browser checks run in the shared mock workflow.

`packages/api/src/media/sdk.ts` adapts the SDK port; `media/native.ts` owns host admission and Message/File replay. `media/sdk.native.spec.ts` and `media/runtime.spec.ts` exercise the real SDK wrapper and host with a controlled provider. `media/tracing.ts` supplies resolved tenant policy and a redacted output projection to `traceModelInvocation`; it does not import raw Langfuse handler constructors or disposal helpers.

To refresh the temporary bridge:

1. Update production source, focused tests and design documentation in the SDK checkout against the intended published base. Run its typecheck, focused native/tracing tests, build and repository contract.
2. Pack the SDK with `npm pack`. Unpack that artifact and a fresh `npm pack @librechat/agents@<pinned version>` artifact into separate package trees. Generate the patch from their production package contents, retaining matching source, CJS, ESM and declarations; do not copy test fixtures into npm `files`.
3. Apply the patch to an independent pristine package tree. Compare every resulting package file with the packed candidate by SHA-256. Install the same verified files while preserving npm-managed nested dependencies.
4. Run LibreChat's installed CJS/ESM contract, native/host tracing suites and workspace typechecks. Keep the exact pin and package-cache hashes synchronized with the patch.

Once the canonical SDK publishes these contracts, consume the actual released version, verify equivalent behavior, and remove this patch, the exact temporary pins, patch-package postinstall/dependency, Docker copy steps and patch-specific cache inputs together. SDK-independent changes may be prepared as separate reviewable slices while that release is pending.
