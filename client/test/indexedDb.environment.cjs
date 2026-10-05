const { TestEnvironment } = require('jest-environment-jsdom');

/**
 * jsdom lacks structuredClone, which IndexedDB requires when persisting values, and lacks
 * BroadcastChannel, which cross-tab queue coordination requires.
 */
module.exports = class IndexedDbEnvironment extends TestEnvironment {
  constructor(...args) {
    super(...args);
    this.global.structuredClone = structuredClone;
    this.global.BroadcastChannel = BroadcastChannel;
  }
};
