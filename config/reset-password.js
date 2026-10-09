const path = require('path');
const bcrypt = require('bcryptjs');
const readline = require('readline');
const mongoose = require('mongoose');
const { createPasswordResetUpdate } = require('@librechat/api');
const { createModels, createMethods } = require('@librechat/data-schemas');
const { User, Passkey, Session } = createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const getLogStores = require('~/cache/getLogStores');
const { askSilentQuestion } = require('./helpers');
const connect = require('./connect');

const methods = createMethods(mongoose, { getCache: getLogStores });

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
    await connect();

    const email = await question('Enter user email: ');
    const user = await User.findOne({ email });

    if (!user) {
      console.error('User not found!');
      process.exit(1);
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
    const updated = await methods.updateUser(
      user._id.toString(),
      /** Stamps credentialsChangedAt and drops any staged enrollment, as the web reset does. */
      createPasswordResetUpdate(hashedPassword),
      {},
      { preserveExpiresAt: true },
    );

    if (!updated) {
      console.error('User not found during update!');
      process.exit(1);
    }

    /**
     * A passkey signs in on its own, so leaving one in place would keep an attacker
     * logged in after an administrator believes the account has been recovered.
     */
    let deletedCount;
    try {
      ({ deletedCount } = await Passkey.deleteMany({ user: user._id }));
      /** A refresh session outlives the stamp: refreshing mints a token issued after it. */
      await Session.deleteMany({ user: user._id });
    } finally {
      /** The password is already changed, so the cache settles even when a revocation fails. */
      await methods.awaitAuthUserDocEviction(user._id.toString());
    }

    console.log('Password successfully reset!');
    if (deletedCount > 0) {
      console.log(`Removed ${deletedCount} passkey(s); the user must enroll again.`);
    }
    process.exit(0);
  } catch (err) {
    console.error('Error resetting password:', err);
    process.exit(1);
  }
};

resetPassword();
