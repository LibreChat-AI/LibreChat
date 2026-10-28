const path = require('path');
const mongoose = require('mongoose');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { silentExit } = require('./helpers');
const { User, Conversation, Message } = require('@librechat/data-schemas').createModels(mongoose);
const connect = require('./connect');

(async () => {
  await connect();

  /**
   * Show the welcome / help menu
   */
  console.purple('-----------------------------');
  console.purple('Show the stats of all users');
  console.purple('-----------------------------');

  const countByUser = async (Model) => {
    const rows = await Model.aggregate([{ $group: { _id: '$user', count: { $sum: 1 } } }]);
    return new Map(rows.map(({ _id, count }) => [String(_id), count]));
  };
  const [users, conversationCounts, messageCounts] = await Promise.all([
    User.find({}),
    countByUser(Conversation),
    countByUser(Message),
  ]);
  const userData = users.map((user) => ({
    User: user.name,
    Email: user.email,
    Conversations: conversationCounts.get(String(user._id)) ?? 0,
    Messages: messageCounts.get(String(user._id)) ?? 0,
  }));

  userData.sort((a, b) => {
    if (a.Conversations !== b.Conversations) {
      return b.Conversations - a.Conversations;
    }

    return b.Messages - a.Messages;
  });

  console.table(userData);

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
