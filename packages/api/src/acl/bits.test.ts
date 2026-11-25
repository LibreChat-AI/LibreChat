import fs from 'node:fs';
import path from 'node:path';

/**
 * `checkPermission` asks whether one ACL row covers every required bit, while the effective
 * permission ORs bits across rows. The Lean model proves the two agree only for a single-bit
 * requirement (`single_bit_agrees` in formal/authz/Authz/Bits.lean) and exhibits the gap for two
 * bits (`multi_bit_gap`). This is a lexical guard: every `requiredPermission` property or
 * assignment in production source must be a single `PermissionBits` member or a forward a reviewer
 * classified below. It does not follow values passed positionally or built elsewhere.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const SCANNED = ['api', 'packages/api/src', 'packages/data-schemas/src'];
const SKIPPED = new Set(['node_modules', 'dist', 'coverage', '__tests__', '__mocks__']);
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

const BIT = 'PermissionBits\\.(?:VIEW|EDIT|DELETE|SHARE|VIEW_INSIGHTS)';
const SINGLE = new RegExp(`^${BIT}$`);
const TERNARY = new RegExp(`^[\\w.!]+ \\? ${BIT} : ${BIT}$`);
const TYPE_ANNOTATION = /^(?:number|PermissionBits)$/;
const DOC_EXAMPLE = /^(?:1|2|4|8|16)$/;
/** A property value ends at the next separator; an assignment runs to the end of the statement. */
const ASSIGNMENT = /\brequiredPermissions?\??\s*(?::\s*([^,;)}\n]+)|=(?!=)\s*([^;\n]+))/g;

const valueOf = (match: RegExpMatchArray): string => (match[1] ?? match[2]).trim();

/**
 * Values that forward a variable, with where its value comes from. Each entry was read by hand;
 * a new one needs the same reading.
 */
const FORWARDED: Record<string, Record<string, string>> = {
  'api/server/controllers/agents/v1.js': {
    'req.query.requiredPermission':
      'agent list filter for findAccessibleResources, not checkPermission; a multi-bit value only narrows the list',
    'parseInt(requiredPermission, 10)':
      'the same list filter parsed from the query string, falling back to PermissionBits.VIEW',
  },
  'packages/api/src/skills/management.ts': {
    permission: 'the first argument of wrap(...), each checked below to be a single bit',
  },
};

interface Finding {
  file: string;
  line: number;
  value: string;
}

function sourcesUnder(directory: string): string[] {
  return fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return SKIPPED.has(entry.name) ? [] : sourcesUnder(relative);
    }
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [relative] : [];
  });
}

/** Returns every `requiredPermission` value in `source` that is not provably a single bit. */
function unclassified(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  for (const match of source.matchAll(ASSIGNMENT)) {
    const value = valueOf(match);
    const start = source.lastIndexOf('\n', match.index) + 1;
    const isDoc = /^\s*\*/.test(source.slice(start, match.index));
    if (SINGLE.test(value) || TERNARY.test(value) || TYPE_ANNOTATION.test(value)) {
      continue;
    }
    if ((isDoc && DOC_EXAMPLE.test(value)) || FORWARDED[file]?.[value] != null) {
      continue;
    }
    findings.push({ file, line: source.slice(0, match.index).split('\n').length, value });
  }
  return findings;
}

describe('production permission checks require a single permission bit', () => {
  const files = SCANNED.flatMap(sourcesUnder);

  test('the scan reaches the permission gates', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'api/server/middleware/accessResources/canAccessResource.js',
        'packages/api/src/shared-links/access.ts',
        'packages/api/src/skills/management.ts',
      ]),
    );
  });

  test('every requiredPermission value is a single bit or a classified forward', () => {
    const findings = files.flatMap((file) =>
      unclassified(file, fs.readFileSync(path.join(ROOT, file), 'utf8')),
    );
    expect(findings).toEqual([]);
  });

  test('every classified forward still exists', () => {
    for (const [file, values] of Object.entries(FORWARDED)) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const found = new Set(Array.from(source.matchAll(ASSIGNMENT), valueOf));
      expect([...Object.keys(values)].filter((value) => !found.has(value))).toEqual([]);
    }
  });

  /** `undefined` skips the per-skill check (list and create). */
  test('skill management wraps each route with a single bit or no resource check', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'packages/api/src/skills/management.ts'),
      'utf8',
    );
    const permissions = Array.from(source.matchAll(/\bwrap\(\s*([^,\s]+),/g), (match) => match[1]);
    expect(permissions.filter((value) => SINGLE.test(value)).length).toBeGreaterThan(0);
    expect(permissions.filter((value) => value !== 'undefined' && !SINGLE.test(value))).toEqual([]);
  });

  test('the detector flags multi-bit and numeric requirements', () => {
    const flagged = (snippet: string) => unclassified('fixture.ts', snippet).map((f) => f.value);
    expect(
      flagged('check({ requiredPermission: PermissionBits.VIEW | PermissionBits.EDIT })'),
    ).toEqual(['PermissionBits.VIEW | PermissionBits.EDIT']);
    expect(flagged('check({ requiredPermission: 3 })')).toEqual(['3']);
    expect(
      flagged('const requiredPermission = PermissionBits.VIEW + PermissionBits.SHARE;'),
    ).toEqual(['PermissionBits.VIEW + PermissionBits.SHARE']);
    expect(flagged('check({ requiredPermission: PermissionBits.SHARE })')).toEqual([]);
    expect(flagged('requiredPermission = PermissionBits.VIEW_INSIGHTS;')).toEqual([]);
    expect(flagged('if (requiredPermission === PermissionBits.EDIT) {}')).toEqual([]);
  });
});
