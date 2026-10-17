const path = require('path');
const mongoose = require('mongoose');
const { v5: uuidv5 } = require('uuid');
const { BANNER_VARIANTS } = require('librechat-data-provider');
const { Banner } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { askQuestion, askMultiLineQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

(async () => {
  await connect();

  /**
   * Show the welcome / help menu
   */
  console.purple('--------------------------');
  console.purple('Update the banner!');
  console.purple('--------------------------');
  /**
   * Set up the variables we need and get the arguments if they were passed in
   */
  let displayFrom = '';
  let displayTo = '';
  let message = '';
  let isPublic = undefined;
  let persistable = undefined;
  let variant = undefined;
  // If we have the right number of arguments, lets use them
  if (process.argv.length >= 3) {
    displayFrom = process.argv[2];
    displayTo = process.argv[3];
    message = process.argv[4];
    isPublic = process.argv[5] === undefined ? undefined : process.argv[5] === 'true';
    persistable = process.argv[6] === undefined ? undefined : process.argv[6] === 'true';
    variant = process.argv[7];
  } else {
    console.orange(
      `Usage: npm run update-banner <displayFrom(Format: yyyy-mm-ddTHH:MM:SSZ)> <displayTo(Format: yyyy-mm-ddTHH:MM:SSZ)> <message> <isPublic(true/false)> <persistable(true/false)> [variant(${BANNER_VARIANTS.join('/')})]`,
    );
    console.orange('Note: if you do not pass in the arguments, you will be prompted for them.');
    console.purple('--------------------------');
  }

  /**
   * If we don't have the right number of arguments, lets prompt the user for them
   */
  if (!displayFrom) {
    displayFrom = await askQuestion('Display From (Format: yyyy-mm-ddTHH:MM:SSZ, Default: now):');
  }

  // Validate the displayFrom format (ISO 8601)
  const dateTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  if (displayFrom && !dateTimeRegex.test(displayFrom)) {
    console.red('Error: Invalid date format for displayFrom. Please use yyyy-mm-ddTHH:MM:SSZ.');
    silentExit(1);
  }

  displayFrom = displayFrom ? new Date(displayFrom) : new Date();

  if (!displayTo) {
    displayTo = await askQuestion(
      'Display To (Format: yyyy-mm-ddTHH:MM:SSZ, Default: not specified):',
    );
  }

  if (displayTo && !dateTimeRegex.test(displayTo)) {
    console.red('Error: Invalid date format for displayTo. Please use yyyy-mm-ddTHH:MM:SSZ.');
    silentExit(1);
  }

  displayTo = displayTo ? new Date(displayTo) : null;

  if (!message) {
    message = await askMultiLineQuestion(
      'Enter your message ((Enter a single dot "." on a new line to finish)):',
    );
  }

  if (message.trim() === '') {
    console.red('Error: Message cannot be empty!');
    silentExit(1);
  }

  if (isPublic === undefined) {
    const isPublicInput = await askQuestion('Is public (y/N):');
    isPublic = isPublicInput.toLowerCase() === 'y' ? true : false;
  }

  if (persistable === undefined) {
    const persistableInput = await askQuestion('Is persistable (cannot be dismissed) (y/N):');
    persistable = persistableInput.toLowerCase() === 'y' ? true : false;
  }

  if (variant === undefined) {
    variant = await askQuestion(`Variant (${BANNER_VARIANTS.join('/')}, Default: none):`);
  }

  variant = variant.trim().toLowerCase();
  if (variant && !BANNER_VARIANTS.includes(variant)) {
    console.red(`Error: Invalid variant. Use one of: ${BANNER_VARIANTS.join(', ')}.`);
    silentExit(1);
  }

  // Generate the same bannerId for the same message
  // This allows us to display only messages that haven't been shown yet
  const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // Use an arbitrary namespace UUID
  const bannerId = uuidv5(message, NAMESPACE);

  let result;
  try {
    // There is always only one Banner record in the DB.
    // If a Banner exists in the DB, it will be updated.
    // If it doesn't exist, a new one will be added.
    const existingBanner = await Banner.findOne();
    if (existingBanner) {
      result = await Banner.findByIdAndUpdate(
        existingBanner._id,
        {
          displayFrom,
          displayTo,
          message,
          bannerId,
          isPublic,
          persistable,
          ...(variant ? { variant } : { $unset: { variant: 1 } }),
        },
        { new: true },
      );
    } else {
      result = await Banner.create({
        displayFrom,
        displayTo,
        message,
        bannerId,
        isPublic,
        persistable,
        ...(variant && { variant }),
      });
    }
  } catch (error) {
    console.red('Error: ' + error.message);
    console.error(error);
    silentExit(1);
  }

  if (!result) {
    console.red('Error: Something went wrong while updating the banner!');
    console.error(result);
    silentExit(1);
  }

  console.green('Banner updated successfully!');
  console.purple(`bannerId: ${bannerId}`);
  console.purple(`from: ${displayFrom}`);
  console.purple(`to: ${displayTo || 'not specified'}`);
  console.purple(`Banner: ${message}`);
  console.purple(`isPublic: ${isPublic}`);
  console.purple(`persistable: ${persistable}`);
  console.purple(`variant: ${variant || 'none'}`);
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
