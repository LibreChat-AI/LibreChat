import { execFileSync } from 'child_process';
import { logger } from '@librechat/data-schemas';

export interface BuildInfo {
  commit: string | null;
  commitShort: string | null;
  branch: string | null;
  buildDate: string | null;
}

let cached: BuildInfo | null = null;

function safeGit(args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      encoding: 'utf8',
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function normalize(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves the current deployment's build info from (in order): explicit env vars,
 * then local git metadata. Used by `/api/config` to expose commit/branch to clients
 * when `interface.buildInfo` is enabled.
 */
export function resolveBuildInfo(): BuildInfo {
  if (cached) {
    return cached;
  }

  const commit = normalize(process.env.BUILD_COMMIT) ?? safeGit(['rev-parse', 'HEAD']);
  const branch =
    normalize(process.env.BUILD_BRANCH) ?? safeGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const buildDate = normalize(process.env.BUILD_DATE);

  const info: BuildInfo = {
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    branch: branch === 'HEAD' ? null : branch,
    buildDate,
  };

  cached = info;

  if (!info.commit && !info.branch && !info.buildDate) {
    logger.debug(
      '[buildInfo] no BUILD_* env vars set and git metadata unavailable; buildInfo will be empty',
    );
  }

  return info;
}

/** Test hook — resets the in-process cache. Not exported from the package barrel. */
export function __resetBuildInfoCacheForTests(): void {
  cached = null;
}
