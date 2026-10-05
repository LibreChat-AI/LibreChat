# Serial database latency Lighthouse CI

Run from the repository root with Node 24 and Chrome installed:

```sh
npm ci
E2E_CHROMIUM_CHANNEL=chrome npm run lighthouse
# Reuse the production build:
E2E_CHROMIUM_CHANNEL=chrome npm run lighthouse:run
# Negative control: this MUST exit nonzero with an LCP assertion failure:
E2E_CHROMIUM_CHANNEL=chrome npm run lighthouse:regression
```

`E2E_BASE_URL=http://localhost:3098` selects another local port. Set `CHROME_PATH` if
chrome-launcher picks the wrong browser — on WSL it prefers the Windows install, whose
debugging port is unreachable from Linux — and `LIGHTHOUSE_CHROME_FLAGS` to append Chrome
flags such as `--no-sandbox`. Each run starts a disposable MongoDB and the real Express
server, registers a local user, and seeds a conversation. No model inference is needed.
Do not point this test at a deployed service. Playwright refuses to reuse an existing
server.

The existing `benchmarks/mongoose-latency-hook.cjs` adds **250 ms per Mongoose
Query/Aggregate execution** in the server process. Independent queries can overlap;
serial queries compound. This is a deterministic approximation of remote database
latency, not a replica topology or network emulator. It also delays query-based
writes; native driver calls, bulk operations and cursor batches are outside its
coverage. Use a TCP latency proxy if those paths need coverage.

The runner makes three cold browser navigations to a populated conversation,
using the production client build and real authentication, config, file and message
routes. It uses desktop settings with `throttlingMethod: provided` so Lighthouse
does not replace the measured server delays with simulated network timing.
Median budgets are LCP **4,500 ms**, CLS **0.1**, and TBT **500 ms**, asserted against
the median of the three runs. These are lab regression budgets, not field web-vitals
percentiles; Lighthouse does not measure INP.
The test also requires the seeded transcript to be the LCP element, so a fast
login page, spinner, or empty shell cannot pass.

## When the gate fails

1. Read the failed audit's measured median and limit in the budget table the runner
   prints immediately before asserting.
2. Open a `.lighthouse/load/lhr-*.report.html` (chat) or `.lighthouse/studio/lhr-*.report.html` (Studio) report. The console also prints API request
   start/end times. A late request start suggests a browser dependency; a long
   request suggests server work or serial database reads.
3. Inspect the relevant path before changing the budget:

| Request / symptom                           | Code to inspect                                                                           | Performance change this protects                                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config waits for repeated user lookups      | `packages/api/src/app/service.ts`, `api/server/middleware/config/app.js`                  | [#14101](https://github.com/LibreChat-AI/LibreChat/pull/14101)                                                                                                                               |
| Message authorization and read run serially | `api/server/routes/messages.js`, `packages/api/src/middleware/messageValidation.ts`       | [#14101](https://github.com/LibreChat-AI/LibreChat/pull/14101)                                                                                                                               |
| Messages wait for the file map              | `client/src/data-provider/Messages/queries.ts`, `client/src/components/Chat/ChatView.tsx` | [#14188](https://github.com/LibreChat-AI/LibreChat/pull/14188)                                                                                                                               |
| Startup repeats auth user reads             | `api/server/controllers/AuthController.js`, `packages/api/src/auth/userDocCache.ts`       | [#14187](https://github.com/LibreChat-AI/LibreChat/pull/14187), [#14343](https://github.com/LibreChat-AI/LibreChat/pull/14343), [#14747](https://github.com/LibreChat-AI/LibreChat/pull/14747) |

Reuse already-loaded user/config data. Start independent reads together, but keep
every read scoped to the authenticated user/tenant and wait for authorization
before returning data. Do not raise a threshold to hide added round trips.

## Adding another scenario

`auditPage({ url, cookies, runs, budgets })` in `audit.ts` invokes the Lighthouse CLI
once per run, redacts authentication headers, prints API timings and asserts the median
budgets. It returns the reports so each scenario can assert its expected final URL and
LCP content; read the LCP element through the exported `lcpElement(report)` helper rather
than an audit id, because Lighthouse renames those between majors. `load.spec.ts` owns
local login state, conversation seeding and transcript assertions; the runner does not
depend on them.

A downstream fork can import this runner from a separate launch spec, supply
cookies from its own authentication fixture and pass its own `budgets` for
launch thresholds. The database delay hook can be preloaded by that fixture's server
configuration. Keep provider-specific authentication and provisioning in that spec.
For launch flows that navigate across documents, also measure entry-to-ready time
with Playwright: LCP resets on a new document, so final-page LCP alone does not
cover the entire launch. This lane does not exercise OpenID/Redis cache priming.

`lighthouse:regression` preloads a test-only hook that adds 16 real, sequential
user reads before message retrieval (at least four extra seconds). It uses the
same page and budget assertions, and never modifies production source. Confirm
that `largest-contentful-paint` fails, rather than treating any process error as
proof. Run the normal command again to restore baseline reports. Reports stay
local or in GitHub job artifacts; session cookie values are redacted before upload.
Same-repository pull requests also receive the last 80 log lines as a failure comment.

The Studio scenario creates an image with the shared local media provider fixture, then audits
three cold restores of that creation with the same budgets and Mongo delay. It asserts that the
LCP element is the image preview. `E2E_MEDIA_PORT` moves the provider listener, generated config,
and health checks together; both scenarios use the isolated single-server harness.
