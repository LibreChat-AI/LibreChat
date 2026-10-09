const { TextEncoder, TextDecoder } = require('node:util');

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoder;
}

/** jsdom lacks fetch primitives; react-router builds a Request per navigation and reads its fields */
if (typeof globalThis.Request === 'undefined') {
  globalThis.Request = class Request {
    constructor(url, init) {
      this.url = String(url);
      this.method = init?.method ?? 'GET';
      this.headers = init?.headers ?? {};
      this.signal = init?.signal;
    }
  };
}
