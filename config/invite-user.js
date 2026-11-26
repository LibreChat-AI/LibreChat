const path = require('path');
const mongoose = require('mongoose');
const {
  checkEmailConfig,
  createInvite,
  getSafeErrorMetadata,
  runAuthenticationOperation,
} = require('@librechat/api');
const { User } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { askQuestion, silentExit, coloredConsole } = require('./helpers');
const methods = require('../api/models');
const { createToken, findToken } = methods;
const loadCustomConfig = require('~/server/services/Config/loadCustomConfig');
const { sendEmail } = require('../api/server/utils');
const connect = require('./connect');

const inviteUser = async () => {
  coloredConsole.purple('--------------------------');
  coloredConsole.purple('Invite a new user account!');
  coloredConsole.purple('--------------------------');

  if (process.argv.length < 5) {
    coloredConsole.orange('Usage: npm run invite-user <email>');
    coloredConsole.orange(
      'Note: if you do not pass in the arguments, you will be prompted for them.',
    );
    coloredConsole.purple('--------------------------');
  }

  // Check if email service is enabled
  if (!checkEmailConfig()) {
    coloredConsole.red('Error: Email service is not enabled!');
    return 1;
  }

  // Get the email of the user to be invited
  let email = '';
  if (process.argv.length >= 3) {
    email = process.argv[2];
  }
  if (!email) {
    email = await askQuestion('Email:');
  }
  /** `findToken` lowercases its email query, but the Token schema has no setter, so an
   * un-normalized address here is written verbatim and can never be looked up again. */
  email = email.trim().toLowerCase();
  // Validate the email
  if (!email.includes('@')) {
    coloredConsole.red('Error: Invalid email address!');
    return 1;
  }

  // Check if the user already exists
  const userExists = await User.findOne({ email });
  if (userExists) {
    coloredConsole.red('Error: A user with that email already exists!');
    return 1;
  }

  const token = await createInvite(email, { createToken, findToken });
  if (typeof token !== 'string') {
    coloredConsole.red('Error: Failed to create the invite token!');
    return 1;
  }

  const inviteLink = `${process.env.DOMAIN_CLIENT}/register?token=${token}`;

  const appName = process.env.APP_TITLE || 'LibreChat';

  if (!checkEmailConfig()) {
    coloredConsole.green(`Send this link to the user: ${inviteLink}`);
    return 0;
  }

  try {
    await sendEmail({
      email: email,
      subject: `Invite to join ${appName}!`,
      payload: {
        appName: appName,
        inviteLink: inviteLink,
        year: String(new Date().getFullYear()),
      },
      template: 'inviteUser.handlebars',
    });
  } catch (error) {
    console.error('Error sending invitation:', getSafeErrorMetadata(error));
    return 1;
  }

  // Done!
  coloredConsole.green('Invitation sent successfully!');
  return 0;
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
  inviteUser,
).then((code) => silentExit(code));

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(getSafeErrorMetadata(err));
  }

  if (err.message.includes('fetch failed')) {
    return;
  } else {
    process.exit(1);
  }
});
