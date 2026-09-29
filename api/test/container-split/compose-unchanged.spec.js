const { createHash } = require('crypto');
const { readFileSync } = require('fs');
const path = require('path');

/**
 * Property 4: Single-container parity — the static NG3/NG10 notice.
 *
 * The harness introduces a *new* compose file and must never convert either
 * existing single-container setup to an auth-enabled MongoDB. Both
 * `deploy-compose.yml` and `utils/docker/test-compose.yml` run one container
 * against `mongod --noauth`, and the Harness_Compose_File copies parts of them
 * — the `mongo` and `meilisearch` image versions `deploy-compose.yml` pins, and
 * the environment values the `env/*.env.example` files mirror — so a change to
 * either file is worth surfacing against what the harness committed.
 *
 * It is surfaced, not enforced. Under NG10 (Req 1.14, 5.11) no check may make a
 * run depend on the project's configuration staying byte-for-byte the same: an
 * upstream registry-org rename (#16005) edited both single-container files, and
 * a pinned digest that *failed* on it stopped a whole run over an edit unrelated
 * to the split. So this guard hashes each file against the digest committed here
 * — the baseline, the same from run to run — and on a mismatch prints exactly one
 * warning per changed file to `process.stderr` (written directly, matching how
 * the Layer A suites surface operator-facing notices) naming the file, the
 * harness files to review against it, and this spec as the place to record the
 * new digest once reviewed. The test then PASSES regardless. Criteria 1.1 and
 * 4.1 are decided by review of the change set, not by this pin.
 *
 * It reads the files and hashes them — no fixture, no `mongosh`, no Docker — so
 * it costs nothing, never self-skips, and runs in the backend lane on every pull
 * request rather than in Layer B's path-scoped lane.
 *
 * **Validates: Requirements 1.14**
 *
 * Check: COMPOSE-UNCHANGED-12
 */

const repoRoot = path.resolve(__dirname, '..', '..', '..');

/** Where this spec records a digest once a change has been reviewed. */
const DIGEST_LOCATION = 'api/test/container-split/compose-unchanged.spec.js';

/**
 * Committed SHA-256 digests of the two single-container compose files, computed
 * from their current contents. Each entry pairs the relative path with the
 * reason its content is tracked and the harness files to review a change
 * against. `reviewTargets` lives beside the digest so this one table says what
 * each file affects; the warning is built from these rather than hard-coding the
 * paths in the message string. To adopt a reviewed change, recompute the digest
 * (`shasum -a 256 <file>`) and update `digest` here in the same change.
 */
const GUARDED_COMPOSE_FILES = [
  {
    file: 'deploy-compose.yml',
    // Single-container deployment topology on `mongod --noauth`. The harness
    // ships its own compose file instead of converting this one; a change here
    // may mean the harness no longer matches the deployment it stands in for.
    digest: 'a0cdcf2cd9c3198d6ff47b16867fa4aa64832899333db6bfd6d02d97e286fb7c',
    reviewTargets: [
      'e2e/container-split/compose.harness.yml (service images and settings)',
      'e2e/container-split/env/*.env.example (environment variables)',
    ],
  },
  {
    file: 'utils/docker/test-compose.yml',
    // Single-container test topology on `mongod --noauth`. Same tracking: the
    // harness must not repoint this file at an auth-enabled MongoDB, and its
    // pinned image versions feed the harness compose file.
    digest: 'ea8a92a8fec0af8f4e6b8568d805e49a1a5d4ccda6f0c105a7f70e03e56597dd',
    reviewTargets: [
      'e2e/container-split/compose.harness.yml (service images and settings)',
      'e2e/container-split/env/*.env.example (environment variables)',
    ],
  },
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Pure comparison, with the expected digest injected rather than read from a
 * committed file, so a unit test can drive a mismatch without editing
 * `deploy-compose.yml`. Returns whether the content matches the committed
 * digest and, on a mismatch, the single operator-facing warning to print —
 * naming the changed file, each review target, and where to record the new
 * digest once reviewed.
 *
 * @param {Buffer} contents - the file's bytes
 * @param {{ file: string, digest: string, reviewTargets: string[] }} entry
 * @returns {{ match: boolean, warning: string | null }}
 */
const compareComposeDigest = (contents, entry) => {
  const actual = sha256(contents);
  if (actual === entry.digest) {
    return { match: true, warning: null };
  }
  const warning =
    `${entry.file} changed since the committed digest. ` +
    `Review ${entry.reviewTargets.join(' and ')} against it, ` +
    `then record the new digest in ${DIGEST_LOCATION}.`;
  return { match: false, warning };
};

describe('COMPOSE-UNCHANGED-12: single-container compose changes are surfaced, not enforced (NG10)', () => {
  it.each(GUARDED_COMPOSE_FILES)(
    '$file: a change is reported as a warning and the check still passes',
    (entry) => {
      const contents = readFileSync(path.join(repoRoot, entry.file));
      const { match, warning } = compareComposeDigest(contents, entry);

      // NG10 (Req 1.14): a difference from the committed digest is at most a
      // warning. Print exactly one per changed file and pass regardless, so an
      // upstream edit unrelated to the split never stops the run.
      if (!match) {
        process.stderr.write(`${warning}\n`);
      }

      expect(match || warning !== null).toBe(true);
    },
  );

  describe('compareComposeDigest', () => {
    it('reports a mismatch as a warning naming both review targets and the digest location', () => {
      const entry = GUARDED_COMPOSE_FILES[0];
      const { match, warning } = compareComposeDigest(
        Buffer.from('content that does not match the committed digest'),
        entry,
      );

      // A mismatch is a warning, never a failure: the pure function reports the
      // divergence but a caller is free to pass, which the it.each cases do.
      expect(match).toBe(false);
      expect(warning).not.toBeNull();
      expect(warning).toContain(entry.file);
      for (const target of entry.reviewTargets) {
        expect(warning).toContain(target);
      }
      expect(warning).toContain(DIGEST_LOCATION);
    });
  });
});
