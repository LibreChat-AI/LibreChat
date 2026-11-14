const path = require('path');
const bcrypt = require('bcryptjs');
const readline = require('readline');
const mongoose = require('mongoose');
const {
  createPasswordResetUpdate,
  restampRetirementCutoff,
  getSafeErrorMetadata,
  runAuthenticationOperation,
} = require('@librechat/api');
const { createModels } = require('@librechat/data-schemas');
const { User } = createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const methods = require('~/models');
const loadCustomConfig = require('~/server/services/Config/loadCustomConfig');
const { askSilentQuestion } = require('./helpers');
const connect = require('./connect');

const question = (query) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
};

const resetPassword = async () => {
  try {
    const email = await question('Enter user email: ');
    const user = await User.findOne({ email });

    if (!user) {
      console.error('User not found!');
      return 1;
    }

    let validPassword = false;
    let newPassword;

    while (!validPassword) {
      newPassword = await askSilentQuestion('Enter new password: ');
      if (newPassword.length < 8) {
        console.log('Password must be at least 8 characters! Please try again.');
        continue;
      }

      const confirmPassword = await askSilentQuestion('Confirm new password: ');
      if (newPassword !== confirmPassword) {
        console.log('Passwords do not match! Please try again.');
        continue;
      }

      validPassword = true;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    /**
     * Routes the write through the data-schemas method so the auth user doc
     * cache entry for this user is invalidated; a raw updateOne would leave a
     * cached document that keeps pre-reset access tokens verifying for the
     * cache TTL.
     */
    const userId = user._id.toString();
    /** Stamps credentialsChangedAt and drops any staged enrollment, as the web reset does. */
    const update = createPasswordResetUpdate(hashedPassword);
    const updated = await methods.updateUser(userId, update, {}, { preserveExpiresAt: true });

    if (!updated) {
      console.error('User not found during update!');
      return 1;
    }

    /**
     * A passkey signs in on its own, so leaving one in place would keep an attacker
     * logged in after an administrator believes the account has been recovered.
     */
    let deletedCount;
    let failure;
    /**
     * The password is already changed, so every step runs and the first failure exits non-zero.
     * The cache settles last: an eviction before the re-stamp could leave a document carrying the
     * earlier cutoff, which keeps accepting a credential minted during the password write.
     */
    for (const step of [
      async () => {
        ({ deletedCount } = await methods.deletePasskeysByUser(userId));
      },
      /** A refresh session outlives the stamp: refreshing mints a token issued after it. */
      () => methods.deleteAllUserSessions(userId),
      () =>
        restampRetirementCutoff(
          'credentialsChangedAt',
          userId,
          update.credentialsChangedAt,
          (cutoff, expectedState) =>
            methods.updateUser(userId, cutoff, expectedState, { preserveExpiresAt: true }),
        ),
      () => methods.awaitAuthUserDocEviction(userId),
    ]) {
      try {
        await step();
      } catch (err) {
        console.error('Password reset step failed:', getSafeErrorMetadata(err));
        failure ??= err;
      }
    }
    if (failure) {
      throw failure;
    }

    console.log('Password successfully reset!');
    if (deletedCount > 0) {
      console.log(`Removed ${deletedCount} passkey(s); the user must enroll again.`);
    }
    return 0;
  } catch (err) {
    console.error('Error resetting password:', getSafeErrorMetadata(err));
    return 1;
  }
};

runAuthenticationOperation(
  {
    initialize: async () => {
      await connect();
      await methods.initializeAuthentication(
        await loadCustomConfig(false, { storageSelection: true }),
      );
    },
    close: () => methods.closeAuthentication(),
    disconnect: () => mongoose.disconnect(),
    error: console.error,
  },
  resetPassword,
).then((code) => process.exit(code));
