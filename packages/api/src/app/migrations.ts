import { logger } from '@librechat/data-schemas';
import type { PromptMigrationCheckResult } from '~/prompts/migration';
import type { MigrationCheckResult } from '~/agents/migration';
import { logPromptMigrationWarning } from '~/prompts/migration';
import { logAgentMigrationWarning } from '~/agents/migration';

export interface StartupMigrationChecks {
  /** Warns about documents missing search tokens; logs its own failures. */
  probeSearchTokens: () => Promise<void>;
  checkAgentPermissions: () => Promise<MigrationCheckResult>;
  checkPromptPermissions: () => Promise<PromptMigrationCheckResult>;
}

/**
 * Startup dry-run checks: missing search tokens and the agent and prompt permission
 * migrations. The three are independent reads, so they run together; each logs its own
 * failure and none stops the others or startup.
 */
export async function checkStartupMigrations(checks: StartupMigrationChecks): Promise<void> {
  await Promise.all([
    checks.probeSearchTokens(),
    checks
      .checkAgentPermissions()
      .then(logAgentMigrationWarning)
      .catch((error: unknown) => {
        logger.error('[checkMigrations] Failed to check agent permissions migration:', error);
      }),
    checks
      .checkPromptPermissions()
      .then(logPromptMigrationWarning)
      .catch((error: unknown) => {
        logger.error('[checkMigrations] Failed to check prompt permissions migration:', error);
      }),
  ]);
}
