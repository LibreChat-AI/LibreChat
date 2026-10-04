import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { LCTool } from '@librechat/agents';

export const GITHUB_COMPARE_NAME = 'github_compare';
export const GITHUB_COMPARE_DEFINITION: LCTool & {
  description: string;
  parameters: NonNullable<LCTool['parameters']>;
} = {
  name: GITHUB_COMPARE_NAME,
  description:
    'Read-only GitHub comparison of two full commit SHAs in a public repository. Returns the merge-base, relation and commit counts without Git, a worktree, or worker admission. Private repositories and arbitrary URLs are not supported. Does not fetch code or execute commands.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'GitHub repository owner.' },
      repo: { type: 'string', description: 'GitHub repository name.' },
      base: { type: 'string', description: 'Full base commit SHA, not a moving branch.' },
      head: { type: 'string', description: 'Full head commit SHA, not a moving branch.' },
    },
    required: ['owner', 'repo', 'base', 'head'],
  },
};

export interface GitHubComparisonInput {
  owner: string;
  repo: string;
  base: string;
  head: string;
}
export interface GitHubComparison {
  base: string;
  head: string;
  mergeBase: string;
  status: string;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
}
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export async function compareGitHubCommits(
  input: GitHubComparisonInput,
  fetchImpl: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => ReturnType<typeof fetch> = fetch,
  signal?: AbortSignal,
): Promise<GitHubComparison> {
  if (
    ![input.owner, input.repo].every((value) => REPO.test(value)) ||
    !SHA.test(input.base) ||
    !SHA.test(input.head)
  ) {
    throw new Error('Supply a repository and full lowercase commit SHAs.');
  }
  const timeout = AbortSignal.timeout(10000);
  const requestSignal = signal == null ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/compare/${input.base}...${input.head}?per_page=1`,
    {
      method: 'GET',
      redirect: 'error',
      signal: requestSignal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub comparison unavailable (HTTP ${response.status}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub comparison returned an invalid response.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      requestSignal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > 2 * 1024 * 1024)
        throw new Error('GitHub comparison response exceeded its bound.');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  const merge = data.merge_base_commit as { sha?: unknown } | undefined;
  const base = data.base_commit as { sha?: unknown } | undefined;
  if (
    base?.sha !== input.base ||
    typeof merge?.sha !== 'string' ||
    !SHA.test(merge.sha) ||
    !['ahead', 'behind', 'identical', 'diverged'].includes(String(data.status)) ||
    ![data.ahead_by, data.behind_by, data.total_commits].every(
      (value) => Number.isSafeInteger(value) && Number(value) >= 0,
    )
  ) {
    throw new Error('GitHub comparison returned an invalid response.');
  }
  return {
    base: input.base,
    head: input.head,
    mergeBase: merge.sha,
    status: String(data.status),
    aheadBy: Number(data.ahead_by),
    behindBy: Number(data.behind_by),
    totalCommits: Number(data.total_commits),
  };
}

export class GitHubCompareTool extends DynamicStructuredTool {
  constructor() {
    super({
      name: GITHUB_COMPARE_NAME,
      description: GITHUB_COMPARE_DEFINITION.description,
      schema: structuredClone(GITHUB_COMPARE_DEFINITION.parameters),
      func: async (input: GitHubComparisonInput, _manager, config) => {
        try {
          return JSON.stringify(await compareGitHubCommits(input, fetch, config?.signal));
        } catch {
          return 'GitHub comparison unavailable. Verify the public repository and full commit SHAs. No worker command was executed.';
        }
      },
    });
  }
}
