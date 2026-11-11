import { resolvePullRequestHost } from './settings';

const DEFAULT_HOST = 'github.com';

/**
 * A pull request page on any provider, ending where the number does: GitHub's
 * `/{owner}/{name}/pull/{n}`, GitLab's `/{group}/.../{name}/-/merge_requests/{n}` and Bitbucket's
 * `/{workspace}/{name}/pull-requests/{n}`. A `/pull/new/` page (what `git push` suggests) has no
 * number and never matches.
 */
const PULL_REQUEST_URL =
  /https:\/\/([A-Za-z0-9.-]+(?::\d{1,5})?)\/((?:[A-Za-z0-9_.-]+\/)+?[A-Za-z0-9_.-]+)\/(?:pull|-\/merge_requests|pull-requests)\/(\d+)(?![\w-])/g;
const MARKERS = ['/pull/', '/merge_requests/', '/pull-requests/'];

/**
 * The pull request of `repo` that command output links to, the last one when it links several,
 * since tools such as `gh pr create` print the link they made last. Links to any other repository
 * or to any host but `host` (the configured one, as `resolvePullRequestHost` returns it) are
 * ignored, so output that mentions another project's or another installation's pull request
 * cannot claim the lane.
 */
export function findPullRequestLink(
  output: string,
  repo: string,
  host: string = DEFAULT_HOST,
): number | null {
  if (!MARKERS.some((marker) => output.includes(marker))) return null;
  const wanted = repo.toLowerCase();
  let found: number | null = null;
  for (const match of output.matchAll(PULL_REQUEST_URL)) {
    const [, linkHost, path, digits] = match;
    if (resolvePullRequestHost(linkHost) !== host) continue;
    if (path.toLowerCase() !== wanted) continue;
    const number = Number(digits);
    if (Number.isSafeInteger(number) && number > 0) found = number;
  }
  return found;
}
