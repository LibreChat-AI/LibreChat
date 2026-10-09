import path from 'path';
import { applyRuntimeEnv } from './runtimeEnv';

type TUser = { email: string; password: string };
type DatabaseConnection = { connection: { close: () => Promise<void> } };

/**
 * Registers the backend's `~` alias in this process. Playwright's require hook only
 * maps it when `api/jsconfig.json` is the nearest path-config to the requiring file,
 * so a stray `api/tsconfig.json` would otherwise break every backend require here.
 */
function registerBackendAlias() {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  require('module-alias')({
    base: path.dirname(require.resolve('@librechat/backend/package.json')),
  });
}

export default async function cleanupUser(user: TUser) {
  applyRuntimeEnv();
  registerBackendAlias();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { connectDb } = require('@librechat/backend/db/connect');
  const {
    findUser,
    deleteConvos,
    deleteMessages,
    deleteAllUserSessions,
  } = require('@librechat/backend/models');
  const {
    User,
    Balance,
    Transaction,
    AclEntry,
    Token,
    Group,
  } = require('@librechat/backend/db/models');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const { email } = user;
  let db: DatabaseConnection | undefined;
  try {
    console.log('🤖: global teardown has been started');
    db = await connectDb();
    console.log('🤖:  ✅  Connected to Database');

    const foundUser = await findUser({ email });
    if (!foundUser) {
      console.log('🤖:  ⚠️  User not found in Database');
      return;
    }

    const userId = foundUser._id;
    console.log('🤖:  ✅  Found user in Database');

    // Delete all conversations & associated messages
    const { deletedCount, messages } = await deleteConvos(userId, {}).catch((error) => {
      if (error instanceof Error && error.message.includes('Conversation not found')) {
        console.log('🤖:  ⚠️  No conversations found for user');
        return { deletedCount: 0, messages: { deletedCount: 0 } };
      }

      throw error;
    });

    if (messages.deletedCount > 0 || deletedCount > 0) {
      console.log(`🤖:  ✅  Deleted ${deletedCount} convos & ${messages.deletedCount} messages`);
    }

    // Ensure all user messages are deleted
    const { deletedCount: deletedMessages } = await deleteMessages({ user: userId });
    if (deletedMessages > 0) {
      console.log(`🤖:  ✅  Deleted ${deletedMessages} remaining message(s)`);
    }

    // Delete all user sessions
    await deleteAllUserSessions(userId.toString());

    // Delete user, balance, transactions, tokens, ACL entries, and remove from groups
    await Balance.deleteMany({ user: userId });
    await Transaction.deleteMany({ user: userId });
    await Token.deleteMany({ userId: userId });
    await AclEntry.deleteMany({ principalId: userId });
    const userIdStr = userId.toString();
    await Group.updateMany({ memberIds: userIdStr }, { $pullAll: { memberIds: [userIdStr] } });
    await User.deleteMany({ _id: userId });

    console.log('🤖:  ✅  Deleted user from Database');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    try {
      await db?.connection.close();
    } catch (error) {
      console.error('Error closing database connection:', error);
    }
  }
}

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
