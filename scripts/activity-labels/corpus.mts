/**
 * Eval corpus for activity-label prose. Two halves:
 *
 * - captured.json: the 9 real payloads from the 2026-07-29 sandbox-probe run,
 *   verbatim from Langfuse, replayed as ONE sequence so continuity variants
 *   see the same run shape production did. `productionLabel` is what shipped.
 * - synthetic: cases built for the failure modes the captured run surfaced
 *   (redundant consecutive batches, register collapse, length overflow) plus
 *   the modes it never exercised (all-failed, partial, parallel columns,
 *   truncation, entry overflow, error-shaped success).
 *
 * A case is a sequence of steps; a step is one label request. Multi-step
 * cases exist to measure cross-batch redundancy: the runner chains each
 * step's generated label into the next step's `previousLabels` for variants
 * that opt in.
 */
import { readFileSync } from 'node:fs';

import type { EvalCase, EvalStep, ToolEntry } from './types.mts';

interface CapturedEntry {
  id: string;
  prompt: string;
  productionLabel: string;
}

const captured = JSON.parse(
  readFileSync(new URL('./captured.json', import.meta.url), 'utf8'),
) as CapturedEntry[];

const capturedRun: EvalCase = {
  id: 'sandbox-probe-run',
  notes: 'the real 9-batch production run, verbatim payloads',
  steps: captured.map((entry) => ({
    id: entry.id,
    verbatim: entry.prompt,
    productionLabel: entry.productionLabel,
  })),
};

const synthetic: EvalCase[] = [
  {
    id: 'all-failed',
    notes: 'every call fails — failure register, verb-first under failure',
    steps: [
      {
        payload: {
          lastAssistantText: "I'll run each of these and report exactly what happens.",
          entries: [
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'cat /etc/shadow' },
              status: 'error',
              error: 'cat: /etc/shadow: Permission denied',
            },
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'ls /nonexistent-dir' },
              status: 'error',
              error: "ls: cannot access '/nonexistent-dir': No such file or directory",
            },
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'curl -sS https://nope.invalid' },
              status: 'error',
              error: 'curl: (6) Could not resolve host: nope.invalid',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'partial-failure',
    notes: 'mixed batch — must not read as all-success or all-failure',
    steps: [
      {
        payload: {
          thinkingExcerpts: [
            'Three probes: create the marker dir, read the shadow file, resolve an invalid host. The first should work, the other two should fail for different reasons.',
          ],
          entries: [
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'mkdir -p /tmp/probe && echo ok' },
              toolOutput: 'stdout:\nok',
              status: 'success',
            },
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'cat /etc/shadow' },
              status: 'error',
              error: 'cat: /etc/shadow: Permission denied',
            },
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'getent hosts nope.invalid' },
              status: 'error',
              error: 'exit code 2',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'parallel-versions',
    notes: 'one batch of parallel lookups — the groupId/parallel-columns shape',
    steps: [
      {
        payload: {
          lastAssistantText: 'Let me look up all three at once.',
          entries: [
            {
              toolName: 'web_search',
              toolInput: { query: 'Node.js latest stable version 2026' },
              toolOutput:
                'Node.js 24.5.0 (Current) released 2026-07-22; v24 enters LTS October 2026. nodejs.org/en/blog/release/v24.5.0',
              status: 'success',
            },
            {
              toolName: 'web_search',
              toolInput: { query: 'Deno latest release version' },
              toolOutput:
                'Deno 2.4.2 released 2026-07-16 with improved node:sqlite compat. deno.com/blog/v2.4',
              status: 'success',
            },
            {
              toolName: 'web_search',
              toolInput: { query: 'Bun latest release version' },
              toolOutput:
                'Bun 1.2.19 released 2026-07-25, adds --compile cross-target for linux-arm64. bun.sh/blog/bun-v1.2.19',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'fib-rapid',
    notes: 'three near-identical consecutive batches — redundancy stress',
    steps: [1, 2, 3].map((n) => ({
      id: `fib-${n}`,
      payload: {
        entries: [
          {
            toolName: 'execute_code',
            toolInput: { code: `print(fib(${n}))` },
            toolOutput: `stdout:\n${[1, 1, 2][n - 1]}`,
            status: 'success',
          },
        ],
      },
    })),
  },
  {
    id: 'mega-batch',
    notes: 'six heterogeneous probes in one batch — length-cap stress (mirrors cpu-meminfo-disk)',
    steps: [
      {
        payload: {
          thinkingExcerpts: [
            "I'll gather the full system picture in one pass: CPU count, memory, disk, limits, user, kernel.",
          ],
          entries: [
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'nproc' },
              toolOutput: 'stdout:\n1',
              status: 'success',
            },
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'cat /proc/meminfo | head -3' },
              toolOutput: 'stdout:\n',
              status: 'success',
            },
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'df -h / /tmp' },
              toolOutput:
                'stdout:\nFilesystem      Size  Used Avail Use% Mounted on\noverlay          16M   12M  4.0M  75% /\ntmpfs            20M     0   20M   0% /tmp',
              status: 'success',
            },
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'ulimit -v' },
              toolOutput: 'stdout:\n16777216',
              status: 'success',
            },
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'whoami' },
              toolOutput: 'stdout:\nsandbox',
              status: 'success',
            },
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'uname -r' },
              toolOutput: 'stdout:\n6.1.102',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'single-trivial',
    notes: 'one boring call — header must still say something the card cannot',
    steps: [
      {
        payload: {
          entries: [
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'ls /mnt/data' },
              toolOutput: 'stdout:\nnotes.md\nresults.csv\nprobe.txt',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'answer-found',
    notes: 'the answer IS the line — a question resolved by one call',
    steps: [
      {
        payload: {
          lastAssistantText: 'Let me find where that 30-second timeout is actually set.',
          entries: [
            {
              toolName: 'grep',
              toolInput: { pattern: 'timeout', path: 'api/server/utils/streams.js' },
              toolOutput:
                'streams.js:41:  const STREAM_TIMEOUT_MS = 30_000; // hard cap per SSE flush\nstreams.js:88:  setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'bare-batch',
    notes: 'no intent, no reasoning — minimum context',
    steps: [
      {
        payload: {
          entries: [
            {
              toolName: 'read_file',
              toolInput: { path: 'package.json' },
              toolOutput: '{\n  "name": "librechat",\n  "version": "0.8.1",\n  ...',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'misleading-intent',
    notes: 'intent asks one question, output answers it the other way',
    steps: [
      {
        payload: {
          lastAssistantText: 'Now checking whether response caching is enabled in this deployment.',
          entries: [
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'grep -A2 "cache:" config/deploy.yaml' },
              toolOutput: 'stdout:\ncache:\n  enabled: false\n  ttl: 3600',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'truncated-output',
    notes: 'output clipped mid-JSON by the 600-char limit',
    steps: [
      {
        payload: {
          entries: [
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'pip list --format=json' },
              toolOutput:
                'stdout:\n' +
                JSON.stringify(
                  Array.from({ length: 60 }, (_, i) => ({
                    name: `package-${i}`,
                    version: `1.${i}.0`,
                  })),
                ),
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'silent-success',
    notes: 'empty output — nothing came back to summarize',
    steps: [
      {
        payload: {
          lastAssistantText: "I'll write the results file now.",
          entries: [
            {
              toolName: 'write_file',
              toolInput: { path: '/mnt/data/results.csv', content: 'run,ms\n1,412\n2,398\n' },
              toolOutput: '',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'edit-verify',
    notes: 'edit plus read-back in one batch — one activity, two calls',
    steps: [
      {
        payload: {
          thinkingExcerpts: [
            'The retry cap is what causes the duplicate sends; dropping it from 5 to 1 and verifying the file took the change.',
          ],
          entries: [
            {
              toolName: 'edit_file',
              toolInput: {
                path: 'api/server/utils/queue.js',
                old: 'const MAX_RETRIES = 5;',
                new: 'const MAX_RETRIES = 1;',
              },
              toolOutput: 'OK',
              status: 'success',
            },
            {
              toolName: 'read_file',
              toolInput: { path: 'api/server/utils/queue.js', range: [10, 14] },
              toolOutput: 'const MAX_RETRIES = 1;\nconst BACKOFF_MS = 250;',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'error-shaped-success',
    notes: 'tool returns an error payload with success status — must not read as success',
    steps: [
      {
        payload: {
          lastAssistantText: 'Searching for the changelog now.',
          entries: [
            {
              toolName: 'web_search',
              toolInput: { query: 'librechat 0.8.1 changelog' },
              toolOutput:
                '{"error":{"code":"rate_limited","message":"Search quota exceeded, retry after 3600s"}}',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'mcp-long-name',
    notes: 'namespaced MCP tool name — echo temptation',
    steps: [
      {
        payload: {
          entries: [
            {
              toolName: 'mcp__github__search_repositories',
              toolInput: { query: 'org:danny-avila librechat-agents' },
              toolOutput:
                '{"total_count":2,"items":[{"full_name":"danny-avila/LibreChat","stars":31200},{"full_name":"danny-avila/agents","stars":410}]}',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'dup-activity-seq',
    notes: 'controlled mirror of captured steps 2/3 — same activity twice in a row',
    steps: [
      {
        id: 'dup-write',
        payload: {
          thinkingExcerpts: [
            'First write a marker file, then a separate call will check it survives.',
          ],
          entries: [
            {
              toolName: 'run_tools_with_bash',
              toolInput: {
                code: 'echo "marker-$(date +%s)" > /tmp/persist-probe.txt && cat /tmp/persist-probe.txt',
              },
              toolOutput: 'stdout:\nmarker-1785932011',
              status: 'success',
            },
          ],
        },
      },
      {
        id: 'dup-confirm',
        payload: {
          entries: [
            {
              toolName: 'run_tools_with_bash',
              toolInput: { code: 'cat /tmp/persist-probe.txt' },
              toolOutput: 'stdout:\nmarker-1785932011',
              status: 'success',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'overflow-entries',
    notes: '14 calls — exercises the 12-entry cap and the "…and 2 more" suffix',
    steps: [
      {
        payload: {
          entries: Array.from({ length: 14 }, (_, i) => ({
            toolName: 'run_tools_with_bash',
            toolInput: { code: `convert page-${i + 1}.svg page-${i + 1}.png` },
            toolOutput: '',
            status: 'success',
          })),
        },
      },
    ],
  },
];

/** Tool names for echo checks; captured steps bake entries into the
 *  verbatim prompt, so they are recovered from the "Tool calls:" lines. */
export function stepEntries(step: EvalStep): ToolEntry[] {
  if (step.payload?.entries) {
    return step.payload.entries;
  }
  return [...(step.verbatim ?? '').matchAll(/^- ([A-Za-z0-9_]+)\(/gm)].map((match) => ({
    toolName: match[1] ?? '',
  }));
}

export const cases: EvalCase[] = [capturedRun, ...synthetic];
