#!/usr/bin/env node
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
const path = require('path');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { createModels, createMethods, runAsSystem } = require('@librechat/data-schemas');
const {
  Key,
  User,
  File,
  Agent,
  Token,
  Group,
  Action,
  Preset,
  Prompt,
  Balance,
  Message,
  Session,
  AclEntry,
  ToolCall,
  Assistant,
  SharedLink,
  PluginAuth,
  MemoryEntry,
  PromptGroup,
  AgentApiKey,
  Transaction,
  Conversation,
  ConversationTag,
} = createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const {
  GenerationJobManager,
  createStreamServices,
  revokeUserCodeEnvironmentWorkers,
  waitForKeyvRedisClient,
} = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');
const { getAppConfig } = require('~/server/services/Config');
const { askQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

const TRIGGER_DRAIN_TIMEOUT_MS = 35_000;
const TRIGGER_DRAIN_POLL_MS = 100;
const methods = createMethods(mongoose, { getCache: getLogStores });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gracefulExit(code = 0) {
  try {
    await mongoose.disconnect();
  } catch (err) {
    console.error('Error disconnecting from MongoDB:', err);
  }
  silentExit(code);
}

(async () => {
  await connect();

  console.purple('---------------');
  console.purple('Deleting a user and all related data');
  console.purple('---------------');

  // 1) Get email
  let email = process.argv[2]?.trim();
  if (!email) {
    email = (await askQuestion('Email:')).trim();
  }

  // 2) Find user
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    console.yellow(`No user found with email "${email}"`);
    return gracefulExit(0);
  }

  // 3) Confirm full deletion
  const confirmAll = await askQuestion(
    `Really delete user ${user.email} (${user._id}) and ALL their data? (y/N)`,
  );
  if (confirmAll.toLowerCase() !== 'y') {
    console.yellow('Aborted.');
    return gracefulExit(0);
  }

  // 4) Ask specifically about transactions
  const confirmTx = await askQuestion('Also delete all transaction history for this user? (y/N)');
  const deleteTx = confirmTx.toLowerCase() === 'y';

  const uid = user._id.toString();

  // The CLI can coordinate live generation aborts only through the shared
  // Redis stream store. Without it, require an explicit offline assertion.
  let streamServices;
  try {
    await waitForKeyvRedisClient();
    streamServices = createStreamServices();
  } catch (error) {
    console.yellow(
      `Shared Redis generation coordination is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
    streamServices = createStreamServices({ useRedis: false });
  }
  const hasSharedGenerationStore = streamServices.isRedis;
  let allProcessesStopped = false;
  if (!hasSharedGenerationStore) {
    const confirmOffline = await askQuestion(
      'Shared Redis generation coordination is unavailable. Confirm ALL LibreChat app, worker, and other deletion CLI processes are stopped before continuing. (y/N)',
    );
    if (confirmOffline.toLowerCase() !== 'y') {
      console.yellow('Aborted. Stop every LibreChat process or enable Redis stream coordination.');
      return gracefulExit(1);
    }
    allProcessesStopped = true;
  } else {
    GenerationJobManager.configure({ ...streamServices, cleanupOnComplete: false });
    GenerationJobManager.initialize();
  }

  let deletionFence;
  let scheduleSuspensionToken;
  let userDeleted = false;

  try {
    deletionFence = new Date();
    let fenceState = await runAsSystem(() =>
      methods.beginAgentTriggerUserDeletion(uid, deletionFence),
    );
    if (fenceState === 'in_progress') {
      deletionFence = undefined;
      if (!allProcessesStopped) {
        const confirmRecovery = await askQuestion(
          'An account-deletion fence already exists. Confirm ALL LibreChat app, worker, and other deletion CLI processes are stopped to recover it only if stale. (y/N)',
        );
        if (confirmRecovery.toLowerCase() !== 'y') {
          throw new Error('Account deletion is already in progress');
        }
        allProcessesStopped = true;
      }

      const recoveredAt = new Date();
      fenceState = await runAsSystem(() =>
        methods.recoverStaleAgentTriggerUserDeletion(uid, recoveredAt),
      );
      if (fenceState !== 'acquired') {
        throw new Error(
          fenceState === 'missing'
            ? 'User disappeared before stale-fence recovery'
            : 'Account deletion is active or its fence is not stale enough to recover',
        );
      }
      deletionFence = recoveredAt;
    }
    if (fenceState === 'missing') {
      deletionFence = undefined;
    }

    if (deletionFence != null) {
      await runAsSystem(() =>
        methods.prepareAgentTriggerUserPurge(uid, deletionFence, user.tenantId),
      );
      // Reversible, token-fenced suspension (the same protocol the HTTP controller uses):
      // an attempt that does not commit restores exactly these rows in the finally block,
      // rather than leaving a surviving account with disabled, erasure-eligible schedules.
      scheduleSuspensionToken = randomUUID();
      await runAsSystem(() =>
        methods.suspendUserSchedulesForDeletion(uid, scheduleSuspensionToken),
      );
      if (hasSharedGenerationStore) {
        const deadline = Date.now() + TRIGGER_DRAIN_TIMEOUT_MS;
        while (
          (await runAsSystem(() =>
            methods.countActiveAgentTriggerDeliveriesByUser(uid, new Date()),
          )) > 0
        ) {
          if (Date.now() >= deadline) {
            throw new Error('Timed out draining active agent trigger deliveries');
          }
          await delay(TRIGGER_DRAIN_POLL_MS);
        }
      }
    }

    if (hasSharedGenerationStore) {
      const cleanupBlockingAgentRuns = await GenerationJobManager.getCleanupBlockingJobIdsForUser(
        uid,
        user.tenantId,
      );
      await Promise.all(
        cleanupBlockingAgentRuns.map((streamId) =>
          GenerationJobManager.abortJob(streamId, { awaitProviderDrain: true }),
        ),
      );
    }

    const deletionAppConfig = await getAppConfig({ baseOnly: true });

    // 5) Build and run deletion tasks
    const tasks = [
      Action.deleteMany({ user: uid }),
      Agent.deleteMany({ author: uid }),
      AgentApiKey.deleteMany({ user: uid }),
      Assistant.deleteMany({ user: uid }),
      Balance.deleteMany({ user: uid }),
      ConversationTag.deleteMany({ user: uid }),
      Conversation.deleteMany({ user: uid }),
      Message.deleteMany({ user: uid }),
      File.deleteMany({ user: uid }),
      Key.deleteMany({ userId: uid }),
      MemoryEntry.deleteMany({ userId: uid }),
      PluginAuth.deleteMany({ userId: uid }),
      Prompt.deleteMany({ author: uid }),
      PromptGroup.deleteMany({ author: uid }),
      Preset.deleteMany({ user: uid }),
      Session.deleteMany({ user: uid }),
      SharedLink.deleteMany({ user: uid }),
      ToolCall.deleteMany({ user: uid }),
      Token.deleteMany({ userId: uid }),
      AclEntry.deleteMany({ principalId: user._id }),
    ];

    if (deleteTx) {
      tasks.push(Transaction.deleteMany({ user: uid }));
    }

    await Promise.all(tasks);
    await runAsSystem(() => methods.deleteSchedulesByUser(uid));

    // 6) Remove user from all groups
    await Group.updateMany({ memberIds: uid }, { $pullAll: { memberIds: [uid] } });

    // 7) Finally delete the user document itself
    const deletedUser = await runAsSystem(() => methods.deleteUserById(uid));
    if (deletedUser.deletedCount !== 1) {
      throw new Error('User disappeared before account deletion could commit');
    }
    userDeleted = true;
    let codeEnvironmentCleanupSafe = true;
    try {
      await revokeUserCodeEnvironmentWorkers({
        mongoose,
        userId: uid,
        appConfig: deletionAppConfig,
      });
    } catch (error) {
      codeEnvironmentCleanupSafe = false;
      console.error('Failed to revoke code environment workers after account deletion:', error);
    }
    if (codeEnvironmentCleanupSafe) {
      await runAsSystem(() => methods.deleteUserCodeEnvironments(uid)).catch((error) =>
        console.error('Failed to delete code environment records after account deletion:', error),
      );
    }
    await runAsSystem(() => methods.deleteAgentTriggerDeliveriesByUser(uid));
  } finally {
    // RESTORE BEFORE RELEASING THE FENCE. While the user-deletion fence is still armed, new
    // schedule writes/claims are refused, so this restore cannot race an owner PATCH nor be
    // superseded by a second deletion attempt re-suspending these rows under a new token.
    if (scheduleSuspensionToken != null && !userDeleted) {
      // Retried inside the method; the fence is still released below on purpose, since
      // retaining it would block the retry that is the convergence path. Print the token
      // so a restore that never converges stays recoverable by hand.
      await runAsSystem(() =>
        methods.restoreUserSchedulesFromDeletion(uid, scheduleSuspensionToken),
      ).catch((error) =>
        console.error(
          `Failed to restore suspended schedules; they remain disabled for user ${uid} under suspension token ${scheduleSuspensionToken}:`,
          error,
        ),
      );
    }
    if (deletionFence != null && !userDeleted) {
      await runAsSystem(() => methods.cancelAgentTriggerUserPurge(uid, deletionFence)).catch(
        (error) => console.error('Failed to disarm trigger purge recovery:', error),
      );
      await runAsSystem(() => methods.cancelAgentTriggerUserDeletion(uid, deletionFence)).catch(
        (error) => console.error('Failed to release account-deletion fence:', error),
      );
    }
    if (hasSharedGenerationStore) {
      await GenerationJobManager.destroy().catch((error) =>
        console.error('Failed to close generation coordination:', error),
      );
    }
  }

  console.green(`✔ Successfully deleted user ${email} and all associated data.`);
  if (!deleteTx) {
    console.yellow('⚠️ Transaction history was retained.');
  }

  return gracefulExit(0);
})().catch(async (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  }
});
