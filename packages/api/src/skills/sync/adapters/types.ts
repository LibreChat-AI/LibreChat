/**
 * `submodule` covers entries that are neither readable files nor descendable
 * directories (a Git submodule, which GitHub reports as `commit`). They are
 * carried through rather than dropped so path-existence checks keep seeing
 * everything the repository actually contains.
 */
export type RepoTreeEntryType = 'blob' | 'tree' | 'submodule';

/**
 * One entry in a repository tree, normalized across providers.
 *
 * `id` is the provider's identifier for the entry's content (a GitHub blob SHA,
 * a GitLab blob id). It is round-tripped back into `fetchFileContent` and
 * persisted in `sourceMetadata`, which lets a later run skip re-downloading a
 * file whose id has not moved. Treat it as opaque outside the adapter.
 *
 * `size` is the blob's byte length when the provider reports it in the tree
 * listing. Skill import limits are enforced against it before any content is
 * downloaded, so an adapter whose tree endpoint omits size must populate it
 * some other way rather than leave it undefined.
 */
export type RepoTreeEntry = {
  path: string;
  type: RepoTreeEntryType;
  id: string;
  size?: number;
};

/** The commit a single sync run is pinned to. */
export type RepoCommit = {
  /** Persisted as the run's `commitSha`; opaque outside the adapter. */
  id: string;
  /**
   * Root tree identifier as of this commit — where `fetchTreeEntries` starts
   * walking. Distinct from `id` on providers whose commit and tree objects are
   * addressed separately (GitHub); equal to `id` where they are not.
   */
  treeId: string;
};

/**
 * Throws when the run has been superseded or shut down. Adapters call it
 * between network round trips so a long listing or download loop stops
 * promptly instead of running to completion against a cancelled run.
 */
export type AssertNotCancelled = () => void;

export type FetchTreeEntriesParams = {
  /** Repository-root-relative directory to list, or `''` for the whole repository. */
  pathPrefix: string;
  assertNotCancelled: AssertNotCancelled;
};

/**
 * The provider-specific surface a skill sync source needs, and nothing more.
 * Everything else in a run — skill discovery, import limits, database upsert
 * and reconciliation, status accounting — is provider-agnostic and depends only
 * on this interface.
 *
 * An adapter is bound to one configured source (its repository coordinates,
 * ref, and credentials) when constructed, so no call takes them again.
 */
export interface GitRepoAdapter {
  /**
   * Resolves the source's configured ref to the commit that pins this run, so
   * every entry listed and file fetched within it stays consistent even if the
   * upstream ref moves mid-sync.
   */
  resolveCommit(): Promise<RepoCommit>;

  /**
   * Lists every entry beneath `pathPrefix` recursively, as of `commit`. Paths
   * are returned relative to the repository root rather than to `pathPrefix`,
   * so entries listed from several configured paths can be merged without
   * ambiguity.
   */
  fetchTreeEntries(commit: RepoCommit, params: FetchTreeEntriesParams): Promise<RepoTreeEntry[]>;

  /**
   * Fetches one file's raw bytes. The caller has already checked `entry.size`
   * against the skill import limits, so implementations do not repeat that.
   */
  fetchFileContent(commit: RepoCommit, entry: RepoTreeEntry): Promise<Buffer>;
}
