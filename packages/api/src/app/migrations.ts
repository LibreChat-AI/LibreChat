import { logger, warnOnMissingSearchTokens } from '@librechat/data-schemas';
import type { MigrationCheckParams, MigrationCheckDbMethods } from '~/agents/migration';
import type { PromptMigrationCheckParams } from '~/prompts/migration';
import { checkPromptPermissionsMigration, logPromptMigrationWarning } from '~/prompts/migration';
import { checkAgentPermissionsMigration, logAgentMigrationWarning } from '~/agents/migration';

export interface StartupMigrationCheckParams {
  mongoose: MigrationCheckParams['mongoose'];
  methods: MigrationCheckDbMethods;
  AgentModel: MigrationCheckParams['AgentModel'];
  PromptGroupModel: PromptMigrationCheckParams['PromptGroupModel'];
}

/**
 * Startup dry-run checks: missing search tokens and the agent and prompt permission
 * migrations. The three are independent reads, so they run together; each logs its own
 * failure and none stops the others or startup.
 */
export async function checkStartupMigrations({
  mongoose,
  methods,
  AgentModel,
  PromptGroupModel,
}: StartupMigrationCheckParams): Promise<void> {
  await Promise.all([
    warnOnMissingSearchTokens(mongoose.connection),
    checkAgentPermissionsMigration({ mongoose, methods, AgentModel })
      .then(logAgentMigrationWarning)
      .catch((error: unknown) => {
        logger.error('[checkMigrations] Failed to check agent permissions migration:', error);
      }),
    checkPromptPermissionsMigration({ mongoose, methods, PromptGroupModel })
      .then(logPromptMigrationWarning)
      .catch((error: unknown) => {
        logger.error('[checkMigrations] Failed to check prompt permissions migration:', error);
      }),
  ]);
}
