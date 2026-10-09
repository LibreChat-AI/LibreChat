/** Code API currently calls listen(port) without a host. Restrict this test child. */
const net = require('node:net');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, callback) {
  return listen.call(this, Number(port), '127.0.0.1', callback);
};
