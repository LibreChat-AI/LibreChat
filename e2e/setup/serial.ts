import fs from 'fs';
import path from 'path';

/**
 * What makes a spec file unsafe to run while another worker runs a different one. Each worker
 * signs in as its own user (`e2e/setup/user.ts`), so a spec that only touches its user's data,
 * a tenant of its own or a throwaway account runs beside any other. These do not:
 */
const RULES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /from '(node:)?child_process'|lint\.helpers'/,
    reason:
      'spawns tooling (ESLint, tsc, Jest, package builds, CLIs, nested Playwright) that shares ' +
      '`packages/*/dist` and scratch trees with other tooling specs, and competes with a browser ' +
      "worker for the runner's CPUs",
  },
  {
    pattern: /\bsetRuntime(Filters|MessageFilterPii|AssistantProtection)\b/,
    reason: "rewrites the server's base config and reloads it for every user",
  },
  {
    pattern: /\/api\/admin\/config\/(role|group)\//,
    reason: 'overrides config for a whole role or group, which other workers belong to',
  },
  {
    pattern:
      /\/__(e2e|debug)\/|\/__(requests|reset|sample)\b|\b(getCodeExecs|getRagQueries|getCodeProvisionedUploads|getRagEmbedded|resetProvisioning)\b/,
    reason:
      "sets, resets or reads a fake harness server's process-wide state (label, code, RAG, " +
      'assistants, git host, Flux, MCP app): its behavior and request logs serve every worker',
  },
  {
    pattern: /\bstartManagementOidc\(\)/,
    reason:
      'starts the management OIDC fixture (`e2e/setup/agent-management.ts`) on its one fixed ' +
      'port and acts as its one user and tenant, which the other management specs create, ' +
      'read and delete',
  },
];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.name.endsWith('.spec.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** The spec files under `testDir` that a rule above marks serial, as absolute paths. */
export function serialSpecs(testDir: string): string[] {
  return walk(testDir).filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return RULES.some(({ pattern }) => pattern.test(source));
  });
}

function alternation(files: string[]): string {
  return files.map((file) => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/**
 * The project pair for one browser profile: `<name>` holds every spec that may run beside
 * another, `<name>-serial` the rest, on one worker. Playwright queues the serial project's files
 * after the other project's, but with more than one worker the first serial file can start
 * while the last parallel one finishes, so a run with more workers takes the projects in two
 * invocations: `--project=<name> --workers=N`, then `--project=<name>-serial`.
 *
 * Playwright's own ordering (`dependencies`, `teardown`) would end that overlap in one
 * invocation, but it runs the other project in full whatever `--test-list`, file arguments or
 * `--grep` selected, so every CI shard would run every serial spec.
 *
 * `testIgnore`, not `testMatch`, divides the files, so a derived config's top-level `testMatch`
 * still selects what either project runs.
 */
export function serialProjects<T extends { name: string }>(
  project: T,
  testDir: string,
): [T & { testIgnore: RegExp }, T & SerialProject] {
  const files = alternation(serialSpecs(testDir));
  return [
    { ...project, testIgnore: new RegExp(`^(?:${files})$`) },
    {
      ...project,
      name: `${project.name}-serial`,
      testIgnore: new RegExp(`^(?!(?:${files})$).*$`),
      workers: 1,
      metadata: { serialOf: project.name },
    },
  ];
}

type SerialProject = {
  name: string;
  testIgnore: RegExp;
  workers: number;
  metadata: { serialOf: string };
};
