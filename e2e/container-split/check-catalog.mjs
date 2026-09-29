// check-catalog.mjs — the single source for the Check Catalog's id → metadata table (task 7.5).
//
// The design's Check Catalog (design.md: "## Check Catalog") assigns every check a stable id
// (GRANT-SHAPE-01 … RUN-REPORT-32), the layer it runs in, the requirement criteria it carries, and
// the parent property it decides (or none, for an apparatus invariant). The check-record serializer
// (serializer.mjs) builds each run report record around these fields, so they live in exactly one
// place here rather than being restated in every checks/*.spec.mjs file. A spec names its check by
// id; the serializer looks the id up here to fill `layer`, `requirements` and `property`. That is
// what keeps the emitted record's metadata equal to the catalog's rather than a per-file transcription
// that could drift from it.
//
// The `property` field mirrors the catalog column verbatim: a parent property tag ('P1', 'P5', 'P6',
// 'P12'), a phrase for the routed-path partition halves, 'setup precondition' for the Layer A
// provisioning guards, or null where the catalog records '—' (an apparatus invariant that decides no
// parent property). `requirements` is the criteria list the catalog's Req column names.
//
// NG1/NG2 hold: this is a static description of the harness's own checks. It touches no application
// code and neither container-split script.
//
// == The profile dimension (task 15.3: "every catalog id the profile selects") ==
// A run names a compose profile — `split` or `collapsed` — and NOT every check is a claim about both
// topologies. The collapsed profile runs ONE container (the `auth-surface` service under an env
// overlay) behind `proxy-collapsed`, with no `api-container` and no allowlist, so a check whose claim
// is about the RELATIONSHIP BETWEEN the two containers has no subject there, and a check whose claim
// the collapse satisfies for free would pass VACUOUSLY (Property 6: no check passes vacuously — and a
// vacuous pass is worse than an absent check, because it reads as evidence).
//
// So each entry carries the profiles that SELECT it, declaratively, here — not as a list in run.mjs or
// reporter.mjs, which is precisely the drift this module exists to prevent. `checkIdsForProfile`
// derives the run's id set from this table; the reporter accounts for exactly those ids and the run
// report's completeness rule is read against them. A check a profile does not select is NOT a skip
// record and NOT a catalog deletion: it is simply not accounted for in that run.
//
// Every entry that is not selected by both profiles carries a comment saying WHY it does not apply
// under `collapsed`. No id is renumbered or removed.

// The compose profiles a run can name (compose.harness.yml defines both). Owned here because the
// catalog's profile dimension is keyed on them and run.mjs — which imports this module — re-exports
// this array as its own `PROFILES`, so the two cannot drift.
export const CHECK_PROFILES = Object.freeze(['split', 'collapsed']);

// The environment variable the runner annotates a Layer B run with (run.mjs: runLayerBChecks), read by
// the reporter and by the checks' live gates so every consumer resolves one profile name.
export const HARNESS_PROFILE_ENV = 'HARNESS_PROFILE';

// The default profile — the one the entry command runs with no flag, and the one a bare `npx jest`
// invocation is judged under.
export const DEFAULT_PROFILE = 'split';

// The `profiles` value for a check that only the two-container topology can decide. Spelled once so
// every split-only entry below points at one array rather than repeating a literal.
const SPLIT_ONLY = Object.freeze(['split']);

// One catalog entry per check id. `layer` is 'A' | 'B' | 'static' | 'recorded' as the catalog's Layer
// column records; `requirements` is the Req column split into individual criteria; `property` is the
// Property column (null where the catalog shows '—'). `partial`, when present, records that the check
// decides only part of the named property — the routed-path partition's load-balancer half — so the
// serializer can emit that scope rather than letting the record overclaim (task 7.5 bullet:
// "Where a check decides only part of a parent property, the record says so"). `profiles`, when
// present, narrows the profiles that select the check; absent, every profile does.
export const CHECK_CATALOG = Object.freeze({
  'GRANT-SHAPE-01': { layer: 'A', requirements: ['3.5'], property: 'P5' },
  'GRANT-ACTIONS-02': { layer: 'A', requirements: ['3.5'], property: 'P5' },
  'GRANT-DENY-READ-03': { layer: 'A', requirements: ['3.6'], property: 'P5' },
  'GRANT-DENY-WRITE-04': { layer: 'A', requirements: ['3.7'], property: 'P5' },
  'GRANT-ALLOW-WRITE-05': { layer: 'A', requirements: ['3.8'], property: 'P5' },
  'GRANT-MATERIALIZE-06': { layer: 'A', requirements: ['3.8'], property: 'P5' },
  'GRANT-DENY-DDL-07': { layer: 'A', requirements: ['3.5'], property: 'P5' },
  'PROVISION-ADMIN-08': {
    layer: 'A',
    requirements: ['2.5', '2.6'],
    property: 'setup precondition',
  },
  'PROVISION-PW-09': { layer: 'A', requirements: ['2.8'], property: 'setup precondition' },
  'PROVISION-IDEMPOTENT-10': { layer: 'A', requirements: ['2.2', '2.7'], property: 'P5' },
  'PROVISION-AUTHSOURCE-11': {
    layer: 'A',
    requirements: ['2.5', '2.6'],
    property: 'setup precondition',
  },
  'COMPOSE-UNCHANGED-12': { layer: 'static', requirements: ['1.14'], property: 'P12' },
  // SPLIT-ONLY. The claim is digest EQUALITY BETWEEN the two services (Req 1.2) — "not the same image"
  // is the only thing it can report. The collapsed profile runs one container, so there is no second
  // digest to compare and the comparison has no subject at all.
  'TOPO-IMAGE-13': { layer: 'B', requirements: ['1.2'], property: null, profiles: SPLIT_ONLY },
  // SPLIT-ONLY. It DIFFS two resolved container environments against env-matrix.md's three buckets
  // (identical / differs-by-design / absent). With one container there is no second environment to
  // diff, and "every identical row is identical" would be a statement about a map compared with
  // itself.
  'TOPO-ENV-14': {
    layer: 'B',
    requirements: ['1.3', '1.4', '1.5', '1.7', '1.8'],
    property: null,
    profiles: SPLIT_ONLY,
  },
  // SPLIT-ONLY. Req 1.6 is a BOTH-CONTAINERS claim: one host librechat.yaml mounted read-only into
  // each, byte-identical inside both. Under `collapsed` the byte-identity half has one operand, so it
  // holds trivially, and only the residual `secureImageLinks: true` read would decide anything — a
  // partially vacuous pass on a criterion about two containers (Property 6). The setting is pinned by
  // the split run against the same committed librechat.harness.yaml, so nothing is lost by not
  // re-deciding it here.
  'TOPO-YAML-15': { layer: 'B', requirements: ['1.6'], property: null, profiles: SPLIT_ONLY },
  // PROFILE-AWARE (both profiles). "The topology came up healthy inside the 300-second window, and
  // provisioning completed before any container started" is meaningful for a one-container topology
  // too, and dropping it would lose real coverage of Req 1.11/1.13 on the collapsed run — which is the
  // run whose whole point is that the collapsed profile actually boots (task 15.5). The expected
  // SERVICE SET is parameterized by profile (bringup.filter.mjs: EXPECTED_SERVICES_BY_PROFILE), not
  // branched on inside an assertion: collapsed expects `proxy-collapsed` and no `api-container`.
  'TOPO-BRINGUP-16': { layer: 'B', requirements: ['1.11', '1.13'], property: null },
  // PROFILE-AWARE (both profiles). "Only the proxy binds the ingress address, and nothing else offers
  // a second external door" holds under both topologies; the collapsed proxy is the `proxy-collapsed`
  // service, so the PROXY NAME is parameterized by profile (bringup.filter.mjs:
  // PROXY_SERVICE_BY_PROFILE). The API_Container clause has no subject under `collapsed` and is
  // satisfied by the service's absence rather than by a branch.
  'TOPO-INGRESS-17': { layer: 'B', requirements: ['1.9', '1.10'], property: null },
  'MONGO-AUTH-18': { layer: 'B', requirements: ['2.1'], property: null },
  // PROFILE-AWARE (both profiles). Req 2.5/2.6 is a per-URI claim — authSource=admin, LibreChat as the
  // default database — and the collapsed container's own MONGO_URI (the Container_2_Grant URI the
  // collapsed overlay hands it) carries it just as the split pair's do. The SERVICE SET whose resolved
  // URI is read is parameterized by profile (mongo.spec.mjs: CONTAINER_SERVICES_BY_PROFILE); the
  // grammar assertion is unchanged.
  'MONGO-URI-19': { layer: 'B', requirements: ['2.5', '2.6'], property: null },
  'BOOT-READY-20': { layer: 'B', requirements: ['3.1'], property: 'P6' },
  'BOOT-CLEAN-21': { layer: 'B', requirements: ['3.2', '2.10'], property: 'P6' },
  // SPLIT-ONLY. Req 3.3 is about the API_CONTAINER reaching a serving state under the
  // Container_2_Grant — a container the collapsed profile does not run. The one collapsed container IS
  // the Auth_Surface service, whose readiness BOOT-READY-20 already decides over a strictly larger
  // path set (/health, /livez, /readyz), so re-deciding it under this id would restate a sibling's
  // observation about a different container's name (Property 6).
  'BOOT-API-22': { layer: 'B', requirements: ['3.3'], property: 'P6', profiles: SPLIT_ONLY },
  // 3.18 sits here and not on PATH-EXERCISE-25: this check is what asserts the `Seeded_Account`
  // insert completed before the boot window's left edge, which is what keeps every write counted
  // inside that window attributable to the Auth_Surface booting under the Container_1_Grant. The
  // seed is a PATH-EXERCISE-25 fixture, but the timing claim is decided by the write count here.
  'BOOT-NOWRITE-23': { layer: 'B', requirements: ['3.9', '3.18'], property: 'P1' },
  // Check id 24 is deliberately vacant. `BOOT-NOWRITE-RO-24` was removed: it booted the Auth_Surface
  // under the read-only observer credential and asserted `/readyz` 200 with zero authorization errors,
  // which is NOT a definite test. If the application attempts a boot write, mongod refuses it with code
  // 13 and the application may CATCH AND SWALLOW the refusal — the container still reaches `/readyz`
  // 200, so the readiness half passes despite a refused write, and the "zero authorization errors" half
  // then depends entirely on the application having LOGGED it. That is the same dependency
  // BOOT-CLEAN-21 already rests on, so it was not the independent second mechanism it claimed to be.
  // BOOT-NOWRITE-23 is strictly better for the same claim (Req 3.9, which it already carries): it reads
  // `system.profile`, the database's own record of issued commands, indifferent to whether the
  // application swallowed or logged anything. The variant also carried a false-failure risk, since
  // booting on a credential no deployment uses can break for reasons unrelated to the property — the
  // legitimate request-path `createIndex` the grant deliberately carries among them. Nothing is
  // renumbered, exactly as with the vacant id 30: PATH-EXERCISE-25 onward keep their numbers.
  // The decision rule (3.4, 3.12, 3.13), the recorded payloads (3.14, 3.15), the seed and session
  // fixtures (3.16, 3.17), the Unconfigured_Provider carve-out (3.19, 3.20, 3.21), the fixture
  // failure a session-gated path exercised anonymously reports (3.22) and the fixture failure a
  // not-recorded-as-gated path answering a clean 401 reports (3.23). The record has to name every
  // one of them: the reporter derives each check record from this table, so a criterion missing here
  // is a criterion the run decided and did not report (Req 5.4). 3.18 is deliberately absent —
  // BOOT-NOWRITE-23 decides it.
  'PATH-EXERCISE-25': {
    layer: 'B',
    requirements: [
      '3.4',
      '3.12',
      '3.13',
      '3.14',
      '3.15',
      '3.16',
      '3.17',
      '3.19',
      '3.20',
      '3.21',
      '3.22',
      '3.23',
      '2.11',
    ],
    property: 'P5',
  },
  'PATH-GROUPSYNC-26': { layer: 'B', requirements: ['3.4'], property: 'P5' },
  // SPLIT-ONLY ON VACUITY GROUNDS (Property 6). This check PASSES under `collapsed` — and only
  // trivially. `Caddyfile.collapsed` is one unconditional upstream with no allowlist, so EVERY path
  // attributes to `auth-surface`, and "each allowlisted path attributes to the Auth_Surface" is true
  // for free no matter what the allowlist says. It would stay green with the allowlist emptied, with
  // the paths misspelled, or with the partition inverted — which is the definition of a vacuous pass,
  // and a vacuous pass is worse than an absent check because it reads as evidence that the routed-path
  // partition was decided. Req 3.10 is a claim about a partition; there is no partition to decide when
  // there is one upstream. The split run decides it at full strength.
  'ROUTE-ALLOW-27': {
    layer: 'B',
    requirements: ['3.10', '2.11'],
    property: 'P2',
    // Decides the load-balancer half of P2 only; the full property also depends on the Auth_Gate,
    // which the harness does not stand up (NG6). The record says so rather than claiming all of P2.
    partial: "routed path partition (P2's load-balancer half)",
    profiles: SPLIT_ONLY,
  },
  // SPLIT-ONLY. The other half of the same partition, and the collapse makes it FALSE rather than
  // vacuous: Req 3.11 says a non-allowlisted path attributes to the API_Container, and the collapsed
  // proxy attributes every path to `auth-surface` — which is the collapse working correctly, not a
  // misroute. A check that must go red on a topology behaving as designed is not a check that topology
  // selects.
  'ROUTE-DEFAULT-28': {
    layer: 'B',
    requirements: ['3.11', '2.11'],
    property: 'P11',
    partial: "routed path partition (P11's load-balancer half)",
    profiles: SPLIT_ONLY,
  },
  'PARITY-COLLAPSE-29': { layer: 'B', requirements: ['4.2'], property: 'P12' },
  // Check id 30 is deliberately vacant. `PARITY-BEHAVIOR-30` was removed with criteria 4.3 and 4.5
  // (task 12.2): it compared each exercised path's status and normalized body against a recorded
  // pre-split baseline, which was unsatisfiable — both Dockerfiles inject BUILD_COMMIT/BUILD_BRANCH/
  // BUILD_DATE that surface through /api/config, so two separately built images cannot produce
  // byte-identical bodies. Nothing is renumbered: the ids are cited by test titles and by the design's
  // negative-control recipes, so PARITY-COLLAPSE-29, PARITY-SUITE-31 and RUN-REPORT-32 keep their
  // numbers and 30 stays empty.
  // Req 4.4 is the property this record owns (the existing suite's counts, carried by reference). It
  // ALSO owns 5.10 and 5.11: the id is decided by reference and reported as a `skip` with skipReason
  // `decided-by-reference` (never a `pass`), which is exactly the reporting contract 5.10 (an
  // unexecuted/recorded check must appear as a skip, not read as passed) and 5.11 (the skip carries a
  // reason from the closed, enumerated set) name (task 17.6).
  'PARITY-SUITE-31': { layer: 'recorded', requirements: ['4.4', '5.10', '5.11'], property: 'P12' },
  'RUN-REPORT-32': {
    layer: 'both',
    // Task 17.5 brings image-identity reporting (5.12) and the reuse notice (5.13) under RUN-REPORT-32,
    // matching the design's Check Catalog. 5.6 stays absent (it is the env-example contract, carried by
    // TOPO-ENV-14), so the list is 5.1–5.5 and 5.7–5.13.
    requirements: [
      '5.1',
      '5.2',
      '5.3',
      '5.4',
      '5.5',
      '5.7',
      '5.8',
      '5.9',
      '5.10',
      '5.11',
      '5.12',
      '5.13',
    ],
    property: null,
  },
});

// The set of valid check ids, frozen. EVERY id the catalog carries, under every profile — this is the
// vocabulary, not a run's selection. Exported so the serializer can reject a record naming an id the
// catalog does not carry — a typo in a spec's check id would otherwise emit a record the run report
// cannot map back to a requirement or property, exactly the opaque pass/fail Req 5.4 forbids. Its
// meaning is deliberately unchanged by the profile dimension: a split-only id is still a KNOWN id, so
// the design's negative-control recipes can name one without the profile narrowing them.
export const CHECK_IDS = Object.freeze(Object.keys(CHECK_CATALOG));

// Look a check id up in the catalog. Throws on an unknown id rather than returning undefined, because
// the id is the key the whole run report is built around: a record whose id is not in the catalog is
// unattributable, and failing loudly at emit time is better than shipping an orphan record to CI.
export function catalogEntryFor(id) {
  const entry = CHECK_CATALOG[id];
  if (entry === undefined) {
    throw new Error(
      `Unknown check id ${JSON.stringify(id)}. It is not in the Check Catalog (design.md). ` +
        `Valid ids: ${CHECK_IDS.join(', ')}. A check must name a catalog id so its record carries ` +
        'the layer, requirement criteria and property the run report maps onto (Req 5.4).',
    );
  }
  return entry;
}

// The profiles that select one check. An entry with no `profiles` field applies to every profile —
// the common case, spelled by omission so only a narrowing carries (and explains) itself.
export function profilesForCheck(id) {
  return catalogEntryFor(id).profiles ?? CHECK_PROFILES;
}

// Whether a profile selects a check. This is the predicate a Layer B spec's live gate uses, so the
// decision to register a live check reads the catalog rather than a second per-file list.
export function checkAppliesToProfile(id, profile) {
  return profilesForCheck(id).includes(profile);
}

// The catalog ids one profile selects, in catalog order. THE run's id set: the reporter accounts for
// exactly these, the early-exit report is built over them, and the artifact's completeness rule is read
// against them. Throws on an unknown profile rather than quietly selecting nothing — an id set silently
// emptied by a typo'd profile name would make every accounting rule pass over zero checks.
export function checkIdsForProfile(profile) {
  if (!CHECK_PROFILES.includes(profile)) {
    throw new Error(
      `Unknown harness profile ${JSON.stringify(profile)}. compose.harness.yml defines: ` +
        `${CHECK_PROFILES.join(', ')}. The profile decides which catalog ids a run accounts for, so ` +
        'an unrecognized name cannot be defaulted away.',
    );
  }
  return Object.freeze(CHECK_IDS.filter((id) => checkAppliesToProfile(id, profile)));
}

// The profile a process is running under, read from the environment the runner annotates
// (HARNESS_PROFILE). Falls back to the default profile for an absent or unrecognized value rather than
// throwing: this is read on REPORTING and GATING paths — a bare `npx jest` sets nothing — and losing
// the whole artifact over an env typo would be the wrong trade. The entry command's own parser
// (run.mjs: parseArgs) already rejects an unknown `--profile` before any of this is reached.
export function profileFromEnv(env = process.env) {
  const value = env?.[HARNESS_PROFILE_ENV];
  return CHECK_PROFILES.includes(value) ? value : DEFAULT_PROFILE;
}
