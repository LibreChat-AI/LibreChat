const path = require('path');
const mongoose = require('mongoose');
const { runBanUserCommand, runAuthenticationOperation } = require('@librechat/api');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { askQuestion, silentExit, coloredConsole } = require('./helpers');
const methods = require('~/models');
const loadCustomConfig = require('~/server/services/Config/loadCustomConfig');
const banViolation = require('~/cache/banViolation');
const connect = require('./connect');

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
  () =>
    runBanUserCommand({
      args: process.argv.slice(2),
      askQuestion,
      findUserByEmail: (email) => methods.findUser({ email }),
      banViolation,
      purple: coloredConsole.purple,
      orange: coloredConsole.orange,
      red: coloredConsole.red,
    }),
).then((code) => silentExit(code));
