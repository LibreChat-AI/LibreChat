/**
 * Failure raised anywhere in a skill sync run — repository access, skill
 * preparation, or database reconciliation. `code` is persisted on the sync
 * status document and surfaced through the admin API, so it must stay a stable
 * machine-readable identifier rather than a message.
 */
export class SkillSyncError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SkillSyncError';
    this.code = code;
  }
}
