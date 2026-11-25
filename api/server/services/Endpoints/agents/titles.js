const {
  TitleStream,
  cacheConfig,
  ioredisClient,
  createTitleTasks,
  RedisEventTransport,
  registerShutdownTask,
  InMemoryEventTransport,
  duplicateIoRedisClient,
  createIoRedisSubscriber,
  createTitleStreamHandler,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const db = require('~/models');

let stream = new TitleStream(new InMemoryEventTransport());
let disconnect = () => {};
let configured = false;

/** Delivery resolves the current transport per call, so Redis can replace it at startup. */
const delivery = {
  settle: (owner, settlement) => stream.settle(owner, settlement),
  subscribe: (owner, subscriber) => stream.subscribe(owner, subscriber),
};

const markers = () => getLogStores(CacheKeys.TITLE_TASKS);

const titleTasks = createTitleTasks({
  saveConvo: db.saveConvo,
  getConvoTitleState: db.getConvoTitleState,
  markers: {
    get: (key) => markers().get(key),
    set: (key, marker, ttl) => markers().set(key, marker, ttl),
    delete: (key) => markers().delete(key),
  },
  cache: { set: (key, title, ttl) => getLogStores(CacheKeys.GEN_TITLE).set(key, title, ttl) },
  stream: delivery,
  logger,
});

const titleStreamHandler = createTitleStreamHandler({
  getConvoTitleState: db.getConvoTitleState,
  markers: { get: (key) => markers().get(key) },
  stream: delivery,
  logger,
});

registerShutdownTask('title streams prepare', () => stream.prepareForShutdown(), {
  phase: 'pre-drain',
  priority: 100,
});
registerShutdownTask(
  'title streams',
  () => {
    stream.destroy();
    disconnect();
  },
  { priority: 90 },
);

/** Moves title delivery onto Redis so a browser on any replica hears every attempt. */
function configureTitleStream() {
  if (configured || !cacheConfig.USE_REDIS) {
    return;
  }
  if (ioredisClient == null || typeof ioredisClient.duplicate !== 'function') {
    throw new Error('Redis title streams require a dedicated subscriber connection.');
  }
  const subscriber = createIoRedisSubscriber(ioredisClient, '[titles] subscriber');
  const publisher = duplicateIoRedisClient(ioredisClient, { enableOfflineQueue: false });
  const previous = stream;
  stream = new TitleStream(new RedisEventTransport(publisher, subscriber));
  previous.destroy();
  configured = true;
  disconnect = () => {
    subscriber.disconnect();
    publisher.disconnect();
  };
}

module.exports = { titleTasks, titleStreamHandler, configureTitleStream };
