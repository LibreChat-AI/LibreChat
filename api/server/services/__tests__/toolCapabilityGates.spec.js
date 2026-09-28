const fs = require('fs');
const path = require('path');

/**
 * `FILE_SEARCH` and `RUN_CODE` are enforced by pairing each read of the matching
 * `AgentCapabilities` entry with the role grant from `resolveToolRoleGrants`.
 * The capability is the deployment switch; the grant is the per-role half. A
 * read that gets one without the other is a hole — which is how every gap in
 * this area has been found: a boundary nobody knew existed.
 *
 * So the boundary list is pinned here. Adding a read of either capability fails
 * this test until it is classified below, which is the point: the classification
 * is the review, and it cannot be skipped by not knowing the site exists.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SEARCH_ROOTS = ['api/app', 'api/server', 'packages/api/src', 'packages/data-provider/src'];
const CAPABILITY_PATTERN =
  /AgentCapabilities\.(execute_code|file_search)\b|EToolResources\.code_interpreter\b/;

/**
 * Every file holding at least one read, with the count and why each is sound.
 * Counts rather than line numbers so ordinary edits above a gate don't churn it.
 */
const CLASSIFIED = {
  // -- Gates: capability AND grant --------------------------------------------
  /** 7 gates + 2 map entries + 2 warning-list entries. */
  'api/server/services/ToolService.js': 11,
  /** `codeEnvAvailable` and `fileSearchAvailable`, both paired after the
   *  startup batch from the one grant read that batch joins. */
  'api/server/services/Endpoints/agents/initialize.js': 2,
  /** `codeEnvAvailable` and `fileSearchAvailable` for the OpenAI-compatible
   *  route, both paired with the shared grant read. */
  'api/server/controllers/agents/openai.js': 2,
  /** `codeEnvAvailable` and `fileSearchAvailable` for the Responses route,
   *  both paired with the shared grant read. */
  'api/server/controllers/agents/responses.js': 2,
  /** `codeEnvAvailable` for the memory-agent initializer. */
  'api/server/controllers/agents/client.js': 1,
  /** Upload processing: two consumer-map entries, the role-gated consumer checks,
   *  and the code-environment/file-search branches. All consumer selection shares
   *  the role grant resolved before routing. */
  'api/server/services/Files/process.js': 5,
  /** Agent-management upload purposes. */
  'api/server/routes/agents/management.js': 2,
  /** Two gates, each paired when the embedder wires `getRoleByName`; one in a
   *  comment. */
  'packages/api/src/agents/openai/service.ts': 3,

  // -- Not gates ---------------------------------------------------------------
  /** The upload-resource map entry, and one mention in a doc comment. */
  'packages/api/src/tools/rolePermissions.ts': 2,
  /** `recordCapabilityToolNames` bookkeeping — describes what was built, does
   *  not decide whether to build it. */
  'packages/api/src/agents/initialize.ts': 2,
  /** Default capability list shipped in config. */
  'packages/data-provider/src/config.ts': 2,
  /** Config normalization only: strips stale `tool_options` when the capability
   *  is off. Execution is gated by the loaders, so this needs no grant. */
  'api/server/controllers/agents/v1.js': 1,
};

/** @returns {string[]} repo-relative files under `dir`, excluding tests. */
function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'dist' ? [] : walk(full);
    }
    if (!/\.(js|ts)$/.test(entry.name) || /\.(test|spec)\.[jt]s$/.test(entry.name)) {
      return [];
    }
    return [full];
  });
}

function collectReads() {
  const found = {};
  for (const root of SEARCH_ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      const matches = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => CAPABILITY_PATTERN.test(line));
      if (matches.length > 0) {
        found[path.relative(REPO_ROOT, file)] = matches.length;
      }
    }
  }
  return found;
}

describe('FILE_SEARCH / RUN_CODE capability reads are all classified', () => {
  const found = collectReads();

  it('has no unclassified file reading a role-gated capability', () => {
    const unclassified = Object.keys(found)
      .filter((file) => CLASSIFIED[file] == null)
      .sort();

    expect({
      unclassified,
      hint: 'A new read of AgentCapabilities.execute_code / file_search or EToolResources.code_interpreter. Pair it with resolveToolRoleGrants, then record it in CLASSIFIED with why it is sound.',
    }).toEqual({ unclassified: [], hint: expect.any(String) });
  });

  it('has no classified file whose read count drifted', () => {
    const drifted = Object.entries(CLASSIFIED)
      .filter(([file, expected]) => (found[file] ?? 0) !== expected)
      .map(([file, expected]) => `${file}: expected ${expected}, found ${found[file] ?? 0}`)
      .sort();

    expect({
      drifted,
      hint: 'A capability read was added or removed. If added, pair it with the grant before updating the count.',
    }).toEqual({ drifted: [], hint: expect.any(String) });
  });
});
