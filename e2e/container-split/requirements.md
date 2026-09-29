# Requirements Document

## Introduction

This document specifies `two-container-test-harness`, a standalone test harness that runs the
LibreChat image in the two-container topology defined by the `auth-api-container-split` feature and
makes that feature's deployment-verification checks runnable locally and in CI. Today the only
compose-based setups — `deploy-compose.yml` and `utils/docker/test-compose.yml` — run the image as
a single container against a MongoDB started with `mongod --noauth`. Neither exercises the split, so
there is no way to observe locally that the Auth_Surface boots clean under its scoped grant, that
its grant refuses collections outside the twelve it is allotted, or that every path routed to it
completes without an authorization error.

The harness composes and configures artifacts that already exist. The two MongoDB grants are
provisioned by `scripts/container-split/provision.mongo.js`; the per-container environment matrix is
recorded in `scripts/container-split/env-matrix.md`; both entrypoints, the route mounts, and the two
provisioning and migration scripts ship with the application. The harness adds a compose topology, a
front proxy that partitions routed paths between the two containers, an auth-enabled MongoDB with the
two provisioned grants applied, and a runner that executes the checks and reports pass or fail. It
changes none of the application code, none of the route mounts, and neither of the two scripts.

The harness validates the credential/grant split and the route partition: the Front_Proxy partitions
routed paths between the two containers, which confirms that the Auth_Surface boots under its scoped
grant with zero authorization failures, that every path routed to it completes without an
authorization error, and that its grant refuses collections outside the twelve (design properties P1,
P5, P6). With the harness collapsed or its split flags unset, single-container behavior is unchanged
(design property P12).

This document defines five requirements. Requirement 1 fixes the two-container compose topology;
Requirement 2 fixes the auth-enabled MongoDB with the two provisioned grants; Requirement 3 governs
route-split and grant-split validation; Requirement 4 governs parity with the single-container setups;
and Requirement 5 governs local and CI runnability. Each requirement names the design property or
verification intent it makes runnable rather than re-deriving the split, which the
`auth-api-container-split` spec owns.

## Glossary

Terms shared with the `auth-api-container-split` spec keep the same meaning here so the two documents
stay consistent.

- **Harness**: The complete test apparatus defined by this spec — the compose topology, the auth-enabled
  MongoDB with both grants applied, the Front_Proxy, and the Test_Runner. Used as the system name for
  obligations that no single component owns.
- **Harness_Compose_File**: The new compose file the Harness introduces, distinct from `deploy-compose.yml`
  and `utils/docker/test-compose.yml`. It stands up an auth-enabled MongoDB and the Front_Proxy in
  addition to the containers and supporting services.
- **Auth_Surface**: Container 1. The LibreChat image configured to serve credential and identity traffic
  and SPA delivery, reachable directly by anonymous traffic, running under the Container_1_Grant. Defined
  by the `auth-api-container-split` design.
- **API_Container**: Container 2. The same LibreChat image configured to serve all remaining application
  paths, running under the Container_2_Grant. In the Harness the API_Container is reached through the
  Front_Proxy.
- **Auth_Gate**: The external admission filter that the parent `auth-api-container-split` design places in
  front of the API_Container in a real deployment, admitting requests carrying a valid credential and
  refusing the rest. In the Harness the API_Container is reached through the Front_Proxy, and the Harness
  does not stand up or emulate the Auth_Gate's credential admission.
- **Load_Balancer**: The component that owns the routed path partition — which request paths resolve to
  the Auth_Surface and which resolve to the API_Container. In the Harness the Load_Balancer role is played
  by the Front_Proxy.
- **Front_Proxy**: The Harness component that stands in for the Load_Balancer, partitioning routed paths
  between the two containers via an explicit allowlist. The Harness does not fix the proxy technology; it
  fixes the capabilities the proxy must express, and those capabilities are the full-path routing and
  allowlist capabilities the partition requires.
- **Grant**: A provisioned MongoDB credential together with the set of collections and access modes it
  permits. **Container_1_Grant** is the Auth_Surface's credential, scoped to twelve collections.
  **Container_2_Grant** is the API_Container's credential, covering all collections.
- **Provisioning_Script**: The existing `scripts/container-split/provision.mongo.js`, run with mongosh to
  create the two scoped MongoDB users and roles. It requires an auth-enabled MongoDB.
- **Auth_Enabled_MongoDB**: A MongoDB instance started with access control on, against which the
  Provisioning_Script has created the two grants, so that each container connects under its own credential
  and MongoDB refuses operations the credential does not permit. Distinct from the `mongod --noauth`
  instance the existing single-container setups use.
- **Routed path**: A request path that the Front_Proxy resolves to a particular container. Distinct from a
  *mounted* path, which both containers have for every route.
- **Auth_Surface_Allowlist**: The explicit list of full-path expressions the Front_Proxy resolves to the
  Auth_Surface. Every path not on the allowlist defaults to the API_Container.
- **Test_Runner**: The Harness component that boots the topology, executes the checks each requirement
  names, reports each check as pass or fail, and tears the topology down.
- **Single_Container_Setup**: Either of the two existing compose files, `deploy-compose.yml` and
  `utils/docker/test-compose.yml`, each running one container against `mongod --noauth`.
- **Authorization_Error**: A MongoDB authorization failure raised because a Grant does not permit an
  operation, whether the failure is fatal or caught and logged.
- **Root_Credential**: The MongoDB administrative credential the Harness uses to start the
  Auth_Enabled_MongoDB and to run the Provisioning_Script, named in criterion 5.8. Distinct from the
  Container_1_Grant and the Container_2_Grant, and never handed to either container.
- **Exercise_Log_Window**: The span of Auth_Surface log output covering one routed path exercise, which
  the Test_Runner scans for an Authorization_Error. Distinct from the startup log window of criteria 3.2
  and 3.9.
- **Path_Payload**: The recorded fixture request the Test_Runner sends when it exercises a routed path —
  a representative, well-formed body, headers and parameters for that path — chosen so the request reaches
  the path's handler.
- **Seeded_Account**: One local LibreChat account the Test_Runner creates in the LibreChat database before
  the routed path exercises, so that a session can be obtained for it.
- **Session_Fixture**: The authenticated session credential the Test_Runner obtains for the Seeded_Account
  and attaches to each exercise of a session-gated routed path. A Session_Fixture is *attached* to an
  exercise when the Test_Runner issues that exercise's request carrying the credential, and *unattached*
  when the request is issued without the credential. An application session obtained through the
  Front_Proxy, not an Auth_Gate credential (NG6).
- **Unconfigured_Provider**: A social login provider for which the Harness supplies no enablement flag and
  no client credential, so the application registers no authentication strategy for that provider and a
  request to the provider's routed path reaches no collection.
- **Uncorroborated_Server_Error**: The outcome the Test_Runner records for a routed path exercise that
  returns an HTTP 5xx status while its Exercise_Log_Window records no Authorization_Error. Neither a clean
  exercise nor evidence of an ownership-matrix understatement.

## Non-Goals and Accepted Constraints

These are constraints on what the Harness may build, not requirements to build anything.

| # | Non-goal / constraint |
|---|---|
| NG1 | Changing any `auth-api-container-split` application code, route mount registration, or HTTP path. The Harness composes and configures existing artifacts only. |
| NG2 | Modifying `scripts/container-split/provision.mongo.js` or `scripts/container-split/migrate.mongo.js`. The Harness runs them; it does not edit them. |
| NG3 | Destabilizing the Single_Container_Setup. The Harness introduces a new compose file rather than converting `deploy-compose.yml` or `utils/docker/test-compose.yml` to auth-enabled MongoDB. |
| NG4 | Re-deriving the split. The collection ownership matrix and the routed path partition are owned by the `auth-api-container-split` spec; the Harness references them and makes their checks runnable. |
| NG5 | Fixing the Front_Proxy technology. The Harness fixes the routing and allowlist capabilities the proxy must express, not the product that expresses them. |
| NG6 | Emulating the Auth_Gate's credential admission. Verifying the Auth_Gate's bearer-token and cookie-exemption admission rules belongs to the `auth-api-container-split` spec, which owns gate verification; the Harness reaches the API_Container through the Front_Proxy and validates the route partition and credential/grant split only. |

## Requirements

### Requirement 1: Two-Container Compose Topology

**User Story:** As an engineer validating the split locally, I want a compose file that runs the same image as two containers behind a front proxy, so that I can exercise the two-container topology without changing application code.

#### Acceptance Criteria

1. THE Harness SHALL provide a Harness_Compose_File that is distinct from `deploy-compose.yml` and from `utils/docker/test-compose.yml`, adding, removing, or modifying zero line of either existing file.
2. THE Harness_Compose_File SHALL define an Auth_Surface service and an API_Container service that both resolve to the same fully-resolved image identity, so that the two containers run the same image with no per-service image difference.
3. THE Harness_Compose_File SHALL limit the configured differences between the Auth_Surface service and the API_Container service to environment variable values, to the MongoDB credential each connects under, and to the routed paths the Front_Proxy resolves to each, matching the three difference categories recorded in `scripts/container-split/env-matrix.md`.
4. THE Harness_Compose_File SHALL configure the Auth_Surface service with `DISABLE_STARTUP_TASKS` set, `MONGO_AUTO_INDEX=false`, `MONGO_AUTO_CREATE=false`, `SEARCH` set to `false` or absent, and `MEILI_HOST` and `MEILI_MASTER_KEY` absent, and SHALL leave each of those settings unset or enabled on the API_Container service, as `scripts/container-split/env-matrix.md` specifies.
5. THE Harness_Compose_File SHALL configure `CREDS_KEY`, the six `OPENID_ROLE_SYNC_*` variables, `USE_ENTRA_ID_FOR_PEOPLE_SEARCH`, `JWT_SECRET`, and `JWT_REFRESH_SECRET` to resolve to the same value on the Auth_Surface service and on the API_Container service.
6. THE Harness_Compose_File SHALL mount the same `librechat.yaml` file into the Auth_Surface service and the API_Container service so that the file is byte-identical across both, and that file SHALL set `secureImageLinks: true`.
7. THE Harness_Compose_File SHALL configure `ALLOW_SHARED_LINKS_PUBLIC` to be absent or false on both the Auth_Surface service and the API_Container service.
8. THE Harness_Compose_File SHALL configure the Redis block on the Auth_Surface service and the API_Container service to resolve identically, so that both services connect to the same Redis instance and the same keyspace, as `scripts/container-split/env-matrix.md` specifies.
9. THE Harness_Compose_File SHALL define a Front_Proxy service positioned in front of both containers such that every external request reaches a container only through the Front_Proxy.
10. THE Harness_Compose_File SHALL route no external request to the API_Container except through the Front_Proxy.
11. WHEN the Harness_Compose_File is brought up, THE Harness SHALL start the Auth_Surface, the API_Container, the Front_Proxy, the Auth_Enabled_MongoDB, and any supporting service the two containers require, and SHALL consider bring-up complete only when each started service reaches a serving state within 300 seconds, observed through that service's health or readiness endpoint.
12. THE Harness SHALL retain the existing route mount registrations and HTTP path layout unchanged, making zero addition, removal, reordering, or renaming of a route mount or a request path.
13. IF any service the Harness_Compose_File starts does not reach a serving state within the 300-second bring-up window, THEN THE Harness SHALL report a setup failure identifying the service that did not reach a serving state and SHALL admit no request-level check against either container.
14. IF, during a Harness run, the content digest of a Single_Container_Setup file differs from the digest committed for that file in the Harness source (a value the Harness never rewrites during a run), THEN THE Harness SHALL print exactly one warning for that file in that run's output, naming the file by its repository-relative path and stating that its content changed since the committed digest, naming the Harness files that mirror that Single_Container_Setup file and must be reviewed against it — the Harness_Compose_File for its service images and settings, and the Harness environment templates for its environment variables — and naming the Harness source file in which the recorded digest is updated once that review is done, SHALL report the digest check for that file as passed (not failed and not skipped), SHALL NOT change the result of any other check, and SHALL end the run with the same exit status it would have had if the digests matched.

#### Rationale

Amendment note on criterion 1.1: the criterion is unchanged in wording and number. That both
Single_Container_Setup files are left unmodified is a property of this change set, decided by review of
the change, not a property the Harness decides at run time. The Harness therefore does not enforce 1.1
by pinning the files' content: upstream edits to those files are routine and unrelated to the split —
an upstream merge (#16005) renamed the image registry org in both `deploy-compose.yml` and
`utils/docker/test-compose.yml`, and a pinned digest stopped the whole run on it. Pinning would make
every run depend on the project's configuration never changing, which criterion 5.11 rules out.

Criterion 1.14 was appended for the same reason. The difference between a Single_Container_Setup file
and the digest committed for it in the Harness source is still worth seeing, so the Harness prints it as a warning naming
the file; it is not a finding about the split, so it fails neither the run nor any check. The baseline
is the digest committed in the Harness source, so it is the same from run to run, and the check reports
`pass` with the warning, not `fail` and not `skip`. The Harness_Compose_File copies parts of the
Single_Container_Setup files — for example the `mongo` and `meilisearch` image versions that
`deploy-compose.yml` pins — so a change there may mean the Harness no longer matches the deployment it
stands in for; the warning names what to review and where to record the reviewed digest, so the warning
disappears only after someone has checked.

### Requirement 2: Auth-Enabled MongoDB With The Two Provisioned Grants

**User Story:** As an engineer validating the credential split, I want the harness to run an access-controlled MongoDB with both scoped grants applied, so that MongoDB itself refuses operations a container's grant does not permit.

#### Acceptance Criteria

1. THE Harness SHALL run an Auth_Enabled_MongoDB started with access control enabled, rather than the `mongod --noauth` instance the Single_Container_Setup uses.
2. WHEN the Auth_Enabled_MongoDB signals it is accepting authenticated connections, THE Harness SHALL apply the two grants by running the unmodified `scripts/container-split/provision.mongo.js` with mongosh against the LibreChat database.
3. IF the Auth_Enabled_MongoDB does not signal readiness within 60 seconds of being started, THEN THE Harness SHALL report a setup failure identifying the readiness timeout and SHALL NOT run the Provisioning_Script.
4. THE Harness SHALL connect the Auth_Surface under the Container_1_Grant credential and the API_Container under the Container_2_Grant credential, so that each container connects under its own provisioned credential.
5. THE Harness SHALL construct each container's `MONGO_URI` with the default database naming the LibreChat database to which the Provisioning_Script scoped its privileges, and with `authSource` naming the `admin` database on which the Provisioning_Script created the two roles and the two users.
6. IF a container's `MONGO_URI` omits `authSource` or names any database other than `admin` as its `authSource`, THEN THE Harness SHALL report a setup failure identifying the authentication-source mismatch and SHALL admit no request-level check against that container.
7. THE Harness SHALL run the Provisioning_Script without editing it, passing the auth-surface password and the API password as two distinct values, and passing any role or user name overrides, through the script's documented mongosh variables.
8. IF the auth-surface password and the API password passed to the Provisioning_Script are equal, THEN THE Harness SHALL report a setup failure identifying the shared-password rejection and SHALL admit no request-level check against either container.
9. IF the Provisioning_Script exits without emitting its success completion signal, THEN THE Harness SHALL report a setup failure carrying the script's failure indication and SHALL admit no request-level check against either container.
10. WHEN the Provisioning_Script has emitted its success completion signal, THE Harness SHALL boot each container against its own provisioned credential and SHALL admit request-level checks only after confirming zero authorization errors across that container's startup logs.
11. WHEN a routing change moves a path between the two routed path sets, THE Harness SHALL surface that the Container_1_Grant must be recomputed from the moved path's collection needs through the checks the Test_Runner runs against the current Auth_Surface_Allowlist and the current Container_1_Grant (a routing misattribution under criteria 3.10 and 3.11, or an ownership-matrix understatement in the criterion 3.4 path exercise, carrying the Provisioning_Script's recompute guidance), and SHALL NOT fail a run because the Auth_Surface_Allowlist differs from a recorded digest of its content.

#### Rationale

Amendment note on criterion 2.11: the criterion keeps its number and was reworded. The earlier wording
was implemented by a pinned digest of the Auth_Surface_Allowlist, so any edit to the allowlist failed
the run whether or not the edit moved a path or left the Container_1_Grant short. That digest is
removed entirely. A moved path already surfaces through the checks run against the current allowlist
and the current grant: attributed to the wrong container it fails the routing checks of 3.10 and 3.11,
and routed to the Auth_Surface with collection needs outside the grant it records an
Authorization_Error in the path exercise of 3.4, which carries the recompute guidance. The reworded
criterion names those checks as the surfacing mechanism and, consistent with criterion 5.11, forbids
failing a run on the allowlist's difference from a recorded digest.

### Requirement 3: Route-Split And Grant-Split Validation

**User Story:** As an engineer, I want the harness to confirm the auth surface boots clean under its scoped grant and that every path routed to it stays inside that grant, so that I know the credential split is sufficient and bounded. (Makes design properties P1, P5, and P6 runnable.)

#### Acceptance Criteria

1. WHEN the Auth_Surface is booted under the Container_1_Grant, THE Test_Runner SHALL assert the Auth_Surface reaches a serving state with `/health`, `/livez`, and `/readyz` answering HTTP 200 within 60 seconds, and SHALL fail the check if that state is not reached. (Design property P6.)
2. WHEN the Auth_Surface is booted under the Container_1_Grant, THE Test_Runner SHALL inspect the startup log window and SHALL fail the check if any Authorization_Error is recorded, counting failures that are caught and logged as well as fatal ones. (Design property P6.)
3. WHEN the API_Container is booted under the Container_2_Grant, THE Test_Runner SHALL assert the API_Container reaches a serving state with `/livez` and `/readyz` answering HTTP 200 within 60 seconds and SHALL fail the check on any recorded Authorization_Error. (Design property P6.)
4. WHEN every path routed to the Auth_Surface is exercised under the Container_1_Grant, THE Test_Runner SHALL decide each such path's grant sufficiency on the Exercise_Log_Window for that exercise, scanning that window for an Authorization_Error whatever HTTP status the exercise returned; IF an Authorization_Error is recorded in that window, THEN THE Test_Runner SHALL fail the check and report the failure as evidence that the ownership matrix understates that routed path's collection needs. (Design property P5.)
5. WHEN the Container_1_Grant is inspected, THE Test_Runner SHALL assert the grant enumerates exactly the twelve collections of the ownership matrix in their specified access modes and no others. (Design property P5.)
6. WHEN a collection outside the Container_1_Grant is read under that grant, THE Test_Runner SHALL assert the read is refused, returns no document, and records an Authorization_Error, covering at least `conversations`, `messages`, `files`, `tokens`, and `keys`. (Design property P5.)
7. WHEN a write to a read-only collection of the Container_1_Grant is attempted under that grant, THE Test_Runner SHALL assert the write is refused with an Authorization_Error and the target collection is left unchanged, covering at least `roles`, `configs`, `systemgrants`, and `banners`. (Design property P5.)
8. WHEN a write to a read-write collection of the Container_1_Grant is attempted under that grant, THE Test_Runner SHALL assert the write is permitted and the written document persists in the target collection, covering at least `users`, `sessions`, `authtokens`, `balances`, `bans`, `groups`, `refreshtokenbridges`, and `openidrefreshflights`. (Design property P5.)
9. WHILE the Auth_Surface boots under the Container_1_Grant, THE Test_Runner SHALL assert zero boot-time MongoDB write is issued, observed through a read-only MongoDB credential distinct from the Container_1_Grant across the 60-second startup window. (Design property P1.)
10. WHEN a request whose full path is on the Auth_Surface_Allowlist arrives at the Front_Proxy, THE Test_Runner SHALL assert the Front_Proxy resolves the request to the Auth_Surface and to no other container, covering at least `/api/auth/*`, `/oauth/*`, `/api/admin/login/*`, `/api/admin/oauth/*`, `/api/config`, and `/api/banner`.
11. THE Front_Proxy SHALL express the Auth_Surface routing rule as an explicit Auth_Surface_Allowlist and SHALL resolve every full path absent from that allowlist to the API_Container, so that the Auth_Surface is never expressed as a default target.
12. IF an exercised routed path returns an HTTP 5xx status and its Exercise_Log_Window records no Authorization_Error, THEN THE Test_Runner SHALL report that exercise as an Uncorroborated_Server_Error carrying the exercised path and the returned status, under a status distinct from the status it reports for a passing exercise and distinct from the status it reports for an ownership-matrix understatement, and SHALL confine the grant-recompute guidance to an exercise whose Exercise_Log_Window records an Authorization_Error. (Design property P5.)
13. WHEN an exercised routed path is attributed to the Auth_Surface, returns a non-5xx HTTP status, and records no Authorization_Error in its Exercise_Log_Window, THE Test_Runner SHALL report that exercise as passing the grant-sufficiency check for that path. (Design property P5.)
14. WHEN a path routed to the Auth_Surface is exercised, THE Test_Runner SHALL issue the request with a Path_Payload that is well-formed for that path's request shape, so that the observed outcome is the application's own validation, authentication, or authorization answer rather than an unhandled error raised on absent input. (Design property P5.)
15. THE Test_Runner SHALL hold the Path_Payload set at one recorded fixture request per exercised routed path, each chosen to reach that path's handler, so that path exercise remains a fixed set of requests rather than generated input variation.
16. WHEN the Test_Runner prepares the routed path exercises, THE Test_Runner SHALL create one Seeded_Account, obtain a Session_Fixture for that account, and attach the Session_Fixture to every exercise of a session-gated routed path, so that a session-gated path reaches the collections its handler queries. (Design property P5.)
17. THE Test_Runner SHALL create the Seeded_Account under the Root_Credential rather than under the Container_1_Grant, so that the seed's outcome is independent of the grant the checks decide on.
18. THE Test_Runner SHALL complete the Seeded_Account creation outside the Auth_Surface boot window that criterion 3.9 observes, so that every write counted inside that window remains attributable to the Auth_Surface booting under the Container_1_Grant. (Design property P1.)
19. WHERE an exercised routed path belongs to an Unconfigured_Provider, THE Test_Runner SHALL assert that the Front_Proxy attributes that path to the Auth_Surface and SHALL leave that path's grant sufficiency undecided, because an Unconfigured_Provider registers no authentication strategy and reaches no collection.
20. WHERE an exercised routed path belongs to an Unconfigured_Provider, THE Test_Runner SHALL report that path's grant sufficiency under a status distinct from the status it reports for a passing exercise, naming the unconfigured provider as the reason the grant-sufficiency question is undecided for that path, so that the narrowed scope is readable in the run report.
21. WHERE the Harness configures a social login provider, THE Test_Runner SHALL exercise that provider's routed path as a full grant-sufficiency exercise under criteria 3.4, 3.12, and 3.13, so that the Unconfigured_Provider narrowing holds only while the provider is absent from the Harness configuration.
22. IF a session-gated routed path is exercised with no Session_Fixture attached, THEN THE Test_Runner SHALL report that exercise as a fixture failure carrying the exercised path and the unattached Session_Fixture, and SHALL withhold from that exercise the passing grant-sufficiency status of criterion 3.13, because the exercise queried no collection and therefore decided nothing about the Container_1_Grant. (Design Property 6 — no check passes vacuously.)
23. IF a routed path that the Test_Runner does not treat as session-gated under criterion 3.16 is exercised without a Session_Fixture, returns HTTP 401, and records no Authorization_Error in its Exercise_Log_Window, THEN THE Test_Runner SHALL report that exercise as a fixture failure carrying the exercised path and naming as the likely cause that the application now requires authentication on that path, and SHALL withhold from that exercise the passing grant-sufficiency status of criterion 3.13. (Design Property 6 — no check passes vacuously.)

#### Rationale

Criteria 3.12 through 3.21 were added and 3.4 amended after a live run decided `PATH-EXERCISE-25` on
the wrong evidence. Eight of the twenty-six exercised paths failed on an HTTP 5xx status alone, and
each failure was reported as evidence that the ownership matrix understates that path's collection
needs. The log scan that would have corroborated the claim never ran on any of the eight, because the
status check stood in front of it.

Criterion 3.4 already named an Authorization_Error as the trigger, not a 5xx — the implementation
deviated from the criterion rather than satisfying a weak one. The amendment therefore makes the
ordering explicit rather than changing what 3.4 decides: the Exercise_Log_Window is scanned whatever
status the exercise returned, and the understatement conclusion is reported only when that window
records an Authorization_Error. A 5xx with no Authorization_Error is a real finding about the
application or the Harness configuration and is not a clean exercise, so 3.12 gives it its own
outcome instead of letting it pass quietly or borrow the recompute guidance, on the same reasoning
that keeps "not executed" separate from "passed" in criterion 5.10.

Three findings from that run motivate the rest:

- Six of the eight failures were `/oauth/{google,github,discord,facebook,openid,apple}`. The Harness
  configures no social provider — no enablement flag and no client credential in any environment
  template — so no strategy is registered and the route answers 5xx because the feature is absent.
  Criteria 3.19 and 3.20 narrow what those paths decide to routing attribution, which they still
  answer; 3.21 keeps the narrowing tied to the configuration rather than making it permanent.
- The other two, `/api/user/verify` and `/api/auth/register`, were sent with no request body. An empty
  body makes the verification handler throw, which is why it answered 5xx rather than the 400 it
  answers for a malformed request; registration answers 403 because registration is not enabled in
  the Harness. A grant gap was investigated and ruled out for registration: its chain needs `bans`
  and `users`, and both are in the Container_1_Grant's read-write set. Criteria 3.14 and 3.15 supply
  a representative payload per path so the application's own answer is what gets observed.
- Roughly ten of the eighteen *passing* paths passed shallowly. An anonymous request refused at the
  gate ahead of the handler issues no MongoDB query, so the log scan finds a clean window because
  nothing was queried. Criterion 3.16 seeds an account and carries a real session so session-gated
  paths reach their collections. Both constraints on that seed are load-bearing: 3.17 keeps the seed
  on the Root_Credential, because seeding with the Container_1_Grant would test the grant with
  itself, and 3.18 keeps the seed outside the boot window, because criterion 3.9 counts writes inside
  that window and is the one property in this requirement decided on direct evidence.

Criterion 3.22 was appended after the design phase found that 3.13 and 3.16 do not compose. Criterion
3.13 grants a pass on three observations — attribution to the Auth_Surface, a non-5xx status, and a
clean Exercise_Log_Window — and an unattached exercise of a session-gated path satisfies all three: the
gate refuses the request with a 401 or 403, which is non-5xx, and the window is clean because the
handler was never reached and no collection was queried. So 3.13 alone would hand a pass to precisely
the vacuous exercise 3.16 exists to eliminate, on evidence identical to what a grant of zero
collections would produce. This is the same indistinguishability that criteria 3.6 and 3.7 answer with
root-seeded target documents, where a refusal against an empty collection reads the same as emptiness.
Criterion 3.22 closes it on the reporting side rather than on the preparation side: 3.16 obliges the
Test_Runner to attach the session, and 3.22 fixes what the run report says when the obligation was not
met, so an unmet fixture surfaces as a fixture failure instead of as grant sufficiency. Criterion 3.13
is unchanged and still decides a properly attached exercise on the same three observations.

Criterion 3.23 was appended because 3.22 only catches a path the Harness already knows to be
session-gated. If the application puts a path behind its authentication middleware and the Harness's
list of session-gated paths does not know it, the anonymous request is refused at the gate with a 401
over a clean Exercise_Log_Window — the same three observations 3.13 passes — so the exercise would pass
without having tested the grant. The observed 401 is the signal the run itself provides, so no list of
session-gated paths needs to be kept in step with the application for the vacuous pass to be caught,
in line with criterion 5.11. A 403 is deliberately not included: among the exercised paths it is the
application's own configuration refusal, for example registration or password reset disabled.
Criterion 3.23 leaves a listed-but-unattached path to 3.22 and a window with an Authorization_Error to
3.4, so no exercise is reported twice. The cause is named as "likely" because a 401 alone cannot prove
the gate answered. Whoever records 401 as an anonymous path's expected status must know this criterion
will fire on that path; no current exercised path does.

Criterion 3.9 and the refusal criteria 3.5 through 3.8 are unchanged. Nothing here asks the Harness to
decide anything about Auth_Gate admission, which NG6 places outside the Harness: the Session_Fixture
is an application session obtained through the Front_Proxy, not a gate credential. The new criteria
are appended and 3.4 amended in place, with no existing criterion renumbered, because `tasks.md`,
`e2e/container-split/check-catalog.mjs`, and the Layer A and Layer B test titles cite criteria by
number.

### Requirement 4: Single-Container Parity

**User Story:** As a maintainer, I want parity with the two Single_Container_Setup configurations — the harness collapses back to one container without touching source or rebuilding, and the project's existing suite comes out the same with the split variables absent — so that adding the harness does not alter how the image behaves outside the split. (Makes design property P12 runnable.)

#### Acceptance Criteria

Numbering note: 4.3 and 4.5 were struck and their numbers are left vacant, so the three criteria
below are 4.1, 4.2 and 4.4 in that order — the third item is 4.4, not 4.3.

1. THE Harness SHALL introduce a new compose file rather than converting `deploy-compose.yml` or `utils/docker/test-compose.yml` to an Auth_Enabled_MongoDB, leaving both Single_Container_Setup files byte-for-byte unchanged.
2. WHEN the Harness topology is collapsed to a single container by unsetting `DISABLE_STARTUP_TASKS`, supplying the full-access MongoDB credential, and removing the Front_Proxy partition, THE Harness SHALL complete the collapse with zero application source-file changes and zero image rebuilds. (Design property P12.)
4. WHEN the existing automated test suite is run with `DISABLE_STARTUP_TASKS` absent, THE Harness SHALL leave that suite with the same count of passing and failing tests the suite produced before the split landed, having modified zero existing test files and zero existing assertions. (Design property P12.)

#### Rationale

The criteria numbered 4.3 and 4.5 were struck. They required every exercised path under the
collapsed configuration to return a status code identical to a pre-split image's and a response body
byte-for-byte identical to it, and required a non-zero exit on any difference. Four reasons, in order
of weight:

1. **Unsatisfiable as written.** Both `Dockerfile` and `Dockerfile.multi` inject `BUILD_COMMIT`,
   `BUILD_BRANCH` and `BUILD_DATE` as build args into the runtime environment, and those values are
   surfaced through `/api/config`, which is one of the paths the Harness exercises. Two separately
   built images therefore cannot produce byte-identical bodies. Meeting the criterion requires a
   normalization list that grows with every such value, and each entry on that list is an admission
   that the comparison is measuring incidental build detail rather than behavior.
2. **Duplicates 4.4 with weaker signal.** Criterion 4.4 already asks the non-regression question and
   answers it with the project's full existing suite — thousands of maintained assertions. Criterion
   4.3 re-asked the same question through byte-diffs of roughly thirty-two HTTP responses.
3. **Does not isolate the split as the variable.** A pre-split image also predates every unrelated
   commit merged since it was built, so a difference in the diff cannot be attributed to the split.
4. **Wrong owner.** The application changes that could alter single-container behavior were made by
   the parent `auth-api-container-split` spec. Non-regression of those changes belongs with that
   change, not with the harness that tests the split. This spec records the result through 4.4 rather
   than re-deriving it.

Criterion 4.4 carries what 4.3 was reaching for, and four things about it are load-bearing:

- The "zero existing test files and zero existing assertions modified" clause is not decorative.
  Without it, a regression could be made to pass by editing the test that caught it, and the same
  count of passing tests would still be reported.
- The claim 4.4 supports is *no detected regression in intended behavior with the split configuration
  absent*. It is not *byte-identical behavior*. The stronger phrasing is exactly what produced the
  infeasible 4.3.
- The suite is source-level. The complementary half — that the image builds and boots — is already
  covered by the existing `docker-smoke.yml` lane, which builds and boots the production image.
  Naming that division keeps the 4.4 claim from being read as covering the image as well.
- No check asserts that the default compose files or Dockerfiles avoid setting the split variables.
  That omission is deliberate: configuration is supposed to change behavior, so a config file
  carrying a split value is a reviewable edit rather than a defect class. The invariant that matters
  — correct behavior when those variables are absent — is a property of the application's defaults
  and is tested there.

Criterion numbers 4.3 and 4.5 are left absent rather than closed up, because downstream artifacts
cite criteria by number and renumbering 4.4 would silently invalidate those references.

Amendment note on criterion 4.1: the criterion is unchanged in wording and number. As with 1.1, leaving
both Single_Container_Setup files byte-for-byte unchanged is a property of this change set, decided by
review, and the Harness does not enforce it by pinning the files' content, because a pin fails on
routine upstream edits unrelated to the split (criterion 5.11). A difference from the digest committed
for either file in the Harness source is reported as the warning of criterion 1.14.

Amendment note on criterion 4.4: the criterion is unchanged in wording and number. It compares against
history — "the same count of passing and failing tests the suite produced before the split landed" —
and no Harness run can observe that history. Like 1.1 and 4.1, it is a property of this change set,
decided by review and by the project's existing backend CI lane that runs the suite. The Harness records
it by reference and reports `PARITY-SUITE-31` as a `skip` with the enumerated reason
`decided-by-reference`. It never reports that check as `pass`, because a pass would claim an observation
the run did not make, and never as a failure caused by a renamed or moved workflow file, because that
would make the run depend on the repository staying unchanged (criterion 5.11). A `decided-by-reference`
skip does not block exit 0.

### Requirement 5: Local And CI Runnability

**User Story:** As an engineer, I want to run the harness with a single documented command locally and hook it into CI, so that the split's verification checks run repeatably rather than by hand.

#### Acceptance Criteria

1. THE Harness SHALL provide a single documented entry command that brings up the topology, runs the checks, reports each check as pass or fail, and tears the topology down, releasing every container and network the entry command created regardless of whether the checks passed or failed.
2. WHEN every configured check passes, THE Test_Runner SHALL exit with status code 0.
3. IF any configured check fails, THEN THE Test_Runner SHALL exit with a non-zero status code and SHALL report, for each failed check, the check identifier and the observation that decided the failure.
4. THE Test_Runner SHALL report, for each check, the design property or verification intent it corresponds to, so that a run maps onto the `auth-api-container-split` verification intents rather than an opaque pass or fail.
5. THE Harness SHALL complete a run with zero interactive prompt, so that the entry command is invocable unchanged from a CI workflow; WHERE a CI lane is added, THE Harness SHALL run there through the same entry command an engineer runs locally, with a CI lane being a later addition rather than a present obligation of this requirement.
6. WHEN the Harness runs, THE Harness SHALL provision its MongoDB credentials, its `CREDS_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, and any test secrets from harness-local configuration rather than from committed secret values, so that no secret value is embedded in a committed file.
7. WHEN the single documented entry command is invoked once, with no operator-supplied variable and no manual step, THE Harness SHALL carry the run from image resolution through topology bring-up, provisioning, check execution, per-check reporting, and teardown.
8. THE Harness SHALL supply every compose interpolation value the topology needs — the topology's image reference, the MongoDB root credential, the MongoDB grant credentials, the database name, and the search master key — from its own configuration, and SHALL resolve each of those values without the operator exporting it.
9. IF the Harness cannot bring the topology up, or cannot execute the checks, THEN THE Harness SHALL report a setup failure identifying what could not be brought up or executed and SHALL exit with a non-zero status code, so that a run that executed no check exits non-zero.
10. THE Test_Runner SHALL report a check that was not executed under a status distinct from the status it reports for a check that passed, so that an unexecuted check is readable as unexecuted rather than as a pass.
11. THE Harness SHALL decide every check against the project files and Harness files (files the Harness ships, such as the Harness_Compose_File and the Auth_Surface_Allowlist) as they are on disk when the run starts, and against the image the run resolves under criterion 5.12, and SHALL NOT fail the run or any check because such a file differs from a recorded copy or recorded digest of its content, reporting that difference at most as a warning, as criterion 1.14 does for the Single_Container_Setup files.
12. WHEN the Harness has resolved the image for a run, THE Harness SHALL report, in the run report and on the terminal, the image's reference (repository and tag), the local image ID that the Auth_Surface and the API_Container were started from, the image's creation time as recorded in the image's metadata in ISO 8601 UTC, and whether the run built the image (the configured tag was absent and the run invoked a build) or reused it (the tag was present and the run invoked no build), including on a run that later ends in the setup failure of criterion 5.9.
13. WHEN a run reuses an existing image, THE Harness SHALL print on the terminal exactly one notice, before the first check executes, stating that the image may not match the current code and naming a command that rebuilds the image under the reported tag, SHALL print that notice on every run that reuses an image and on no run that builds one, SHALL perform no comparison between the image and the current code, and SHALL NOT fail the run or any check because the image was reused.

#### Rationale

Criteria 5.7 through 5.10 close a gap the original six criteria left open: as written, they were
satisfied by a single entry command that performed setup and exited 0 without bringing up a topology
or running a check. That is the outcome actually shipped, so the criteria now name each stage the one
invocation must reach (5.7), place the burden of every compose interpolation value on the Harness
rather than on the operator's shell (5.8), forbid a zero exit from a run that executed no check
(5.9), and separate "not executed" from "passed" in the report so the two can never be conflated
(5.10).

CI execution is out of scope for this revision: the Harness is not required to run from a CI lane
yet, and the existing backend lane is not modified. Criterion 5.5 keeps the obligation that matters
across that boundary — one entry command, identical locally and in CI — so that when a lane does land
it adds a caller rather than a second code path.

The new criteria are appended rather than interleaved, and no existing criterion number changed, for
the same reason 4.3 and 4.5 were left vacant: downstream artifacts cite criteria by number.

Criterion 5.11 was appended so the Harness validates only the current code. The project's code and
configuration change regularly, and a check pinned to a recorded snapshot of a file fails on routine
edits unrelated to the split — upstream #16005 renamed the image registry org in both
Single_Container_Setup files and a pinned digest stopped the whole run — while testing the file's
history rather than the code present at run time. Each check therefore decides against what is on disk
and in the image when the run starts; criteria 1.14 and 2.11 are the two places this replaces a pin.

Scope note on criterion 5.11: the criterion is unchanged in wording and number. Three points fix its
reach:

- Harness files — the Caddyfiles, the list of exercised paths, the Path_Payloads, the env templates and
  the Harness_Compose_File — are edited together by whoever changes the Harness, and are not checked for
  change at run time.
- Application code and project configuration MAY be checked for change, and such a check only ever
  warns. Criterion 1.14 is the one instance.
- Criterion 3.5's check of the Container_1_Grant is not a snapshot in 5.11's sense. Criterion 3.5 itself
  fixes the expected value — exactly the twelve collections in their modes — so a change to the grant
  the Provisioning_Script produces is the finding 3.5 exists to report, and that check still fails on it
  by design.

Criteria 5.12 and 5.13 were appended as the achievable form of "test what is there". The Harness may reuse an
existing image, and a check that the image matches the current code is not available to it: a real
match check would need git, which the design's NG9 forbids, and is meaningless for an uncommitted
tree. The Harness therefore reports honestly what it tested — the image's tag, local image ID and creation
time, and whether this run built or reused it — and, when it reused one, prints a single notice that
the image may not match the current code together with the rebuild command, then tests the image that
is there. A locally built image has an image ID but no repository digest, so the local image ID is what
is reported. "Built" and "reused" are defined by whether the run invoked a build, because a fully cached
build can report an existing ID and an old creation time.
