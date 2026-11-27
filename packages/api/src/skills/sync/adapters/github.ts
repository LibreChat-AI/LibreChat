import type { SkillSyncGitHubSourceConfig } from 'librechat-data-provider';
import type {
  RepoCommit,
  RepoTreeEntry,
  GitRepoAdapter,
  AssertNotCancelled,
  RepoTreeEntryType,
  FetchTreeEntriesParams,
} from './types';
import { normalizeRepoPath } from '../path';
import { SkillSyncError } from '../errors';

const GITHUB_API_BASE = 'https://api.github.com';

export const GITHUB_FINE_GRAINED_TOKEN_RECOMMENDATION =
  'Use a GitHub fine-grained personal access token scoped to the selected repository with read-only Contents and Metadata permissions.';

type FetchFn = typeof fetch;

type GitHubTreeEntry = {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url: string;
};

type GitHubTreeResponse = {
  sha: string;
  tree: GitHubTreeEntry[];
  truncated: boolean;
};

type GitHubBlobResponse = {
  sha: string;
  content: string;
  encoding: string;
  size: number;
};

type GitHubCommitResponse = {
  sha: string;
  commit: {
    tree: {
      sha: string;
    };
  };
};

export type GitHubRepoAdapterConfig = {
  source: SkillSyncGitHubSourceConfig;
  token: string;
  fetchFn: FetchFn;
};

function buildGitHubHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'LibreChat-Skill-Sync',
  };
}

function buildGitHubUrl(pathname: string): string {
  return `${GITHUB_API_BASE}${pathname}`;
}

function encodeGitHubPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

async function readGitHubErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : undefined;
  } catch {
    return undefined;
  }
}

function isGitHubRateLimitResponse(params: {
  status: number;
  remaining: string | null;
  retryAfter: string | null;
  message?: string;
}): boolean {
  if (params.status === 429 || params.remaining === '0' || params.retryAfter) {
    return true;
  }
  const message = params.message?.toLowerCase() ?? '';
  return message.includes('rate limit') || message.includes('abuse detection');
}

async function githubJson<T>(params: {
  fetchFn: FetchFn;
  token: string;
  pathname: string;
}): Promise<T> {
  let response: Response;
  try {
    response = await params.fetchFn(buildGitHubUrl(params.pathname), {
      headers: buildGitHubHeaders(params.token),
    });
  } catch {
    throw new SkillSyncError(
      'GITHUB_REQUEST_FAILED',
      'GitHub request failed before receiving a response',
    );
  }
  if (response.ok) {
    return (await response.json()) as T;
  }
  const remaining = response.headers.get('x-ratelimit-remaining');
  const retryAfter = response.headers.get('retry-after');
  const message = await readGitHubErrorMessage(response);
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    const code = isGitHubRateLimitResponse({
      status: response.status,
      remaining,
      retryAfter,
      message,
    })
      ? 'GITHUB_RATE_LIMITED'
      : 'GITHUB_AUTH_FAILED';
    throw new SkillSyncError(code, `GitHub request failed with HTTP ${response.status}`);
  }
  if (response.status === 404) {
    throw new SkillSyncError('GITHUB_NOT_FOUND', 'GitHub repository, ref, or path was not found');
  }
  throw new SkillSyncError(
    'GITHUB_REQUEST_FAILED',
    `GitHub request failed with HTTP ${response.status}`,
  );
}

/** GitHub reports submodules as `commit` entries; every other type maps across as-is. */
function toRepoTreeEntryType(type: GitHubTreeEntry['type']): RepoTreeEntryType {
  return type === 'commit' ? 'submodule' : type;
}

function toRepoTreeEntry(entry: GitHubTreeEntry, path: string): RepoTreeEntry {
  return {
    path,
    type: toRepoTreeEntryType(entry.type),
    id: entry.sha,
    size: entry.size,
  };
}

export function createGitHubRepoAdapter(config: GitHubRepoAdapterConfig): GitRepoAdapter {
  const { source, token, fetchFn } = config;
  const owner = encodeURIComponent(source.owner);
  const repo = encodeURIComponent(source.repo);

  async function fetchTree(treeSha: string, recursive: boolean): Promise<GitHubTreeResponse> {
    return githubJson<GitHubTreeResponse>({
      fetchFn,
      token,
      pathname: `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(treeSha)}${
        recursive ? '?recursive=1' : ''
      }`,
    });
  }

  /**
   * GitHub addresses trees by SHA rather than by path, so reaching a configured
   * subdirectory means walking one non-recursive listing per path segment before
   * the recursive listing that actually enumerates it.
   */
  async function resolveTreeShaAtPath(
    rootTreeSha: string,
    normalizedPath: string,
    assertNotCancelled: AssertNotCancelled,
  ): Promise<string> {
    let treeSha = rootTreeSha;
    for (const segment of normalizedPath.split('/')) {
      assertNotCancelled();
      const tree = await fetchTree(treeSha, false);
      assertNotCancelled();
      if (tree.truncated) {
        throw new SkillSyncError('GITHUB_TREE_TRUNCATED', 'GitHub tree response was truncated');
      }
      const next = tree.tree.find((entry) => entry.type === 'tree' && entry.path === segment);
      if (!next) {
        throw new SkillSyncError(
          'GITHUB_PATH_NOT_FOUND',
          `Configured GitHub skill path "${normalizedPath}" was not found`,
        );
      }
      treeSha = next.sha;
    }
    return treeSha;
  }

  async function resolveCommit(): Promise<RepoCommit> {
    const commit = await githubJson<GitHubCommitResponse>({
      fetchFn,
      token,
      pathname: `/repos/${owner}/${repo}/commits/${encodeGitHubPath(source.ref)}`,
    });
    return { id: commit.sha, treeId: commit.commit.tree.sha };
  }

  async function fetchTreeEntries(
    commit: RepoCommit,
    params: FetchTreeEntriesParams,
  ): Promise<RepoTreeEntry[]> {
    const normalizedPath = normalizeRepoPath(params.pathPrefix);
    const treeSha = normalizedPath
      ? await resolveTreeShaAtPath(commit.treeId, normalizedPath, params.assertNotCancelled)
      : commit.treeId;

    params.assertNotCancelled();
    const tree = await fetchTree(treeSha, true);
    params.assertNotCancelled();
    if (tree.truncated) {
      throw new SkillSyncError('GITHUB_TREE_TRUNCATED', 'GitHub tree response was truncated');
    }
    if (!normalizedPath) {
      return tree.tree.map((entry) => toRepoTreeEntry(entry, entry.path));
    }
    return tree.tree.map((entry) =>
      toRepoTreeEntry(entry, `${normalizedPath}/${normalizeRepoPath(entry.path)}`),
    );
  }

  async function fetchFileContent(_commit: RepoCommit, entry: RepoTreeEntry): Promise<Buffer> {
    const blob = await githubJson<GitHubBlobResponse>({
      fetchFn,
      token,
      pathname: `/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(entry.id)}`,
    });
    if (blob.encoding !== 'base64') {
      throw new SkillSyncError(
        'GITHUB_UNSUPPORTED_BLOB',
        `Unsupported GitHub blob encoding "${blob.encoding}"`,
      );
    }
    return Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
  }

  return { resolveCommit, fetchTreeEntries, fetchFileContent };
}
