const handleText = require('./handleText');
const sendEmail = require('./sendEmail');
const queue = require('./queue');
const files = require('./files');
const { isOpenIdConfigured } = require('./isOpenIdConfigured');

module.exports = {
  ...handleText,
  sendEmail,
  ...files,
  ...queue,
  isOpenIdConfigured,
};
