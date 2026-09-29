const { readFileSync } = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { configSchema } = require('librechat-data-provider');

/**
 * The harness's `librechat.yaml` fixture is schema-valid and pins
 * `secureImageLinks: true`.
 *
 * `e2e/container-split/compose.harness.yml` mounts
 * `e2e/container-split/librechat.harness.yaml` into both containers at
 * `/app/librechat.yaml`. It used to mount the repository-root `librechat.yaml`,
 * which is untracked and gitignored — each developer's local operator config —
 * so the harness outcome was a function of local state. A key the config schema
 * does not recognize makes `loadCustomConfig.js` call `process.exit(1)`, so both
 * containers died at every boot on a machine whose local config carried one, and
 * a green run on any other machine reproduced nothing about that.
 *
 * This guard is the fast half of the fix. Validating the fixture by eye is not
 * enough: the failure mode is a `configSchema.strict()` rejection, which is
 * whatever the schema currently says rather than whatever a reader remembers it
 * saying. So the fixture is parsed here through the SAME schema object
 * `api/server/services/Config/loadCustomConfig.js` parses with
 * (`configSchema.strict().safeParse`, `librechat-data-provider`), which means a
 * schema change that would kill both containers at boot fails this test in
 * milliseconds instead of arriving as a 300-second bring-up timeout with the real
 * cause buried in a container log tail.
 *
 * It also pins `secureImageLinks: true`, which
 * `scripts/container-split/env-matrix.md` requires on both containers: with the
 * setting false, `createValidateImageRequest` returns a pass-through and image
 * ownership binding disappears with no error surfaced. `TOPO-YAML-15` asserts the
 * same thing against the file as the running containers see it; this asserts it
 * against the committed source, so the fixture cannot drift out from under the
 * live check.
 *
 * Needs no `mongosh`, no fixture server and no Docker, so — like
 * `compose-unchanged.spec.js` beside it — it never self-skips and runs in the
 * backend lane on every pull request.
 *
 * **Validates: Requirements 1.6**
 */

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const fixturePath = path.join(repoRoot, 'e2e', 'container-split', 'librechat.harness.yaml');

describe('the harness librechat.yaml fixture', () => {
  /** The committed fixture's raw text, read once. */
  const fixtureText = readFileSync(fixturePath, 'utf8');

  it('is committed under a name the bare-name .gitignore rule cannot swallow', () => {
    // `.gitignore` ignores `librechat.yaml` by bare name, so the pattern matches
    // at any depth. A fixture named exactly `librechat.yaml` under
    // e2e/container-split/ would be silently ignored and never committed, which
    // is the untracked-file defect this fixture exists to fix. The distinct name
    // is what makes it immune to that rule.
    expect(path.basename(fixturePath)).toBe('librechat.harness.yaml');
    expect(fixtureText.length).toBeGreaterThan(0);
  });

  it('parses as YAML into an object', () => {
    // `loadCustomConfig.js` reads the file with js-yaml before parsing it, so a
    // fixture that is not a YAML mapping fails before the schema is consulted.
    const parsed = yaml.load(fixtureText);
    expect(parsed).toBeInstanceOf(Object);
    expect(Array.isArray(parsed)).toBe(false);
  });

  it('validates against configSchema.strict() — the parse loadCustomConfig.js performs', () => {
    const parsed = yaml.load(fixtureText);

    // The SAME parse loadCustomConfig.js performs. `.strict()` is the half that
    // matters: a plain z.object would strip an unrecognized key, while
    // `.strict()` rejects it — which is exactly how an unrecognized key becomes
    // `process.exit(1)` and a container that never serves.
    const result = configSchema.strict().safeParse(parsed);

    // On failure, surface the schema's own issues rather than a bare `false`, so
    // the message names the offending key the way the application's log would.
    expect({
      success: result.success,
      issues: result.success ? [] : result.error.issues,
    }).toEqual({ success: true, issues: [] });
  });

  it('is validated by a parse that actually rejects an unrecognized key', () => {
    // The negative control for the test above. A guard that only ever asserts
    // "the fixture parses" cannot distinguish a strict schema from a permissive
    // one: a plain z.object strips unknown keys and would pass the fixture just
    // as happily, so the passing assertion above would prove nothing about the
    // failure mode it exists to catch. Adding the exact key that killed both
    // containers — a key absent from configSchema — must make this same parse
    // fail, which is what shows the parse is live and strict rather than
    // vacuous.
    const withUnknownKey = { ...yaml.load(fixtureText), builtinToolsConfig: {} };
    const result = configSchema.strict().safeParse(withUnknownKey);

    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
  });

  it('sets secureImageLinks: true (env-matrix.md, asserted live by TOPO-YAML-15)', () => {
    const result = configSchema.strict().safeParse(yaml.load(fixtureText));
    expect(result.success).toBe(true);
    // Read off the PARSED value, not the text: the text form is TOPO-YAML-15's
    // business (it reads the bytes the containers see), and the value is what the
    // application acts on.
    expect(result.data.secureImageLinks).toBe(true);
  });

  it('carries no top-level key beyond the two the harness needs', () => {
    // Minimality is a property worth pinning, not a style preference. Every extra
    // top-level key is configuration no check reads and a second place a default
    // lives, and each one is another surface on which a schema change can break
    // the boot of both containers.
    expect(Object.keys(yaml.load(fixtureText)).sort()).toEqual(['secureImageLinks', 'version']);
  });
});
