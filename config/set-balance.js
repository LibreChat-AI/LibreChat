const path = require('path');
const mongoose = require('mongoose');
const { getBalanceConfig } = require('@librechat/api');
const { User, Balance } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { getAppConfig } = require('~/server/services/Config');
const { askQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

(async () => {
  await connect();

  /**
   * Show the welcome / help menu
   */
  console.purple('--------------------------');
  console.purple('Set balance to a user account!');
  console.purple('--------------------------');
  /**
   * Set up the variables we need and get the arguments if they were passed in
   */
  let email = '';
  let amount = '';
  // If we have the right number of arguments, lets use them
  if (process.argv.length >= 3) {
    email = process.argv[2];
    amount = process.argv[3];
  } else {
    console.orange('Usage: npm run set-balance <email> <amount>');
    console.orange('Note: if you do not pass in the arguments, you will be prompted for them.');
    console.purple('--------------------------');
    // console.purple(`[DEBUG] Args Length: ${process.argv.length}`);
  }

  const appConfig = await getAppConfig();
  const balanceConfig = getBalanceConfig(appConfig);
  if (!balanceConfig?.enabled) {
    console.red('Error: Balance is not enabled. Use librechat.yaml to enable it');
    silentExit(1);
  }

  /**
   * If we don't have the right number of arguments, lets prompt the user for them
   */
  if (!email) {
    email = await askQuestion('Email:');
  }
  // Validate the email
  if (!email.includes('@')) {
    console.red('Error: Invalid email address!');
    silentExit(1);
  }

  // Validate the user
  const user = await User.findOne({ email }).lean();
  if (!user) {
    console.red('Error: No user with that email was found!');
    silentExit(1);
  } else {
    console.purple(`Found user: ${user.email}`);
  }

  let balance = await Balance.findOne({ user: user._id }).sort({ _id: 1 }).lean();
  if (!balance) {
    console.purple('User has no balance!');
  } else {
    console.purple(`Current Balance: ${balance.tokenCredits}`);
  }

  if (!amount) {
    amount = await askQuestion('amount:');
  }
  // Validate the amount
  if (!amount) {
    console.red('Error: Please specify an amount!');
    silentExit(1);
  }

  /**
   * Now that we have all the variables we need, lets set the balance
   */
  let result;
  try {
    result =
      (await Balance.findOneAndUpdate(
        { user: user._id },
        { tokenCredits: amount },
        { new: true, sort: { _id: 1 } },
      ).lean()) ??
      (await Balance.findOneAndUpdate(
        { _id: user._id },
        { $set: { tokenCredits: amount }, $setOnInsert: { user: user._id } },
        { upsert: true, new: true },
      ).lean());
  } catch (error) {
    console.red('Error: ' + error.message);
    console.error(error);
    silentExit(1);
  }

  // Check the result
  if (result?.tokenCredits == null) {
    console.red('Error: Something went wrong while updating the balance!');
    console.error(result);
    silentExit(1);
  }

  // Done!
  console.green('Balance set successfully!');
  console.purple(`New Balance: ${result.tokenCredits}`);
  silentExit(0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (err.message.includes('fetch failed')) {
    return;
  } else {
    process.exit(1);
  }
});
