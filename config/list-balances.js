const path = require('path');
const mongoose = require('mongoose');
const { User, Balance } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { silentExit } = require('./helpers');
const connect = require('./connect');

(async () => {
  await connect();

  /**
   * Show the welcome / help menu
   */
  console.purple('-----------------------------');
  console.purple('Show the balance of all users');
  console.purple('-----------------------------');

  const users = await User.find({});
  /** Earliest balance per user, matching the previous per-user `findOne().sort({ _id: 1 })` */
  const balances = await Balance.aggregate([
    { $match: { user: { $in: users.map((user) => user._id) } } },
    { $sort: { _id: 1 } },
    { $group: { _id: '$user', tokenCredits: { $first: '$tokenCredits' } } },
  ]);
  const balanceByUser = new Map(balances.map((balance) => [String(balance._id), balance]));
  for (const user of users) {
    const balance = balanceByUser.get(String(user._id)) ?? null;
    if (balance !== null) {
      console.green(`User ${user.name} (${user.email}) has a balance of ${balance.tokenCredits}`);
    } else {
      console.yellow(`User ${user.name} (${user.email}) has no balance`);
    }
  }

  silentExit(0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (!err.message.includes('fetch failed')) {
    process.exit(1);
  }
});
