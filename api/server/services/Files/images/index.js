const convert = require('./convert');
const encode = require('./encode');
const resize = require('./resize');

module.exports = {
  ...convert,
  ...encode,
  ...resize,
};
