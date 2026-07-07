require('dotenv').config();
const { optionalEnabled, instrumentMongooseQueryMetrics } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { buildAutoEncryptionOptions } = require('~/csfle/index');
const { runStartupMigration } = require('~/csfle/manager');

const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGO_URI;

instrumentMongooseQueryMetrics(mongoose);

if (!MONGO_URI) {
  throw new Error('Please define the MONGO_URI environment variable');
}
/** The maximum number of connections in the connection pool. */
const maxPoolSize = parseInt(process.env.MONGO_MAX_POOL_SIZE) || undefined;
/** The minimum number of connections in the connection pool. */
const minPoolSize = parseInt(process.env.MONGO_MIN_POOL_SIZE) || undefined;
/** The maximum number of connections that may be in the process of being established concurrently by the connection pool. */
const maxConnecting = parseInt(process.env.MONGO_MAX_CONNECTING) || undefined;
/** The maximum number of milliseconds that a connection can remain idle in the pool before being removed and closed. */
const maxIdleTimeMS = parseInt(process.env.MONGO_MAX_IDLE_TIME_MS) || undefined;
/** The maximum time in milliseconds that a thread can wait for a connection to become available. */
const waitQueueTimeoutMS = parseInt(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS) || undefined;
/** Set to false to disable automatic index creation for all models associated with this connection. */
const autoIndex = optionalEnabled(process.env.MONGO_AUTO_INDEX);

/** Set to `false` to disable Mongoose automatically calling `createCollection()` on every model created on this connection. */
const autoCreate = optionalEnabled(process.env.MONGO_AUTO_CREATE);
/**
 * Global is used here to maintain a cached connection across hot reloads
 * in development. This prevents connections growing exponentially
 * during API Route usage.
 */
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

mongoose.connection.on('error', (err) => {
  logger.error('[connectDb] MongoDB connection error:', err);
});

async function connectDb() {
  if (cached.conn && cached.conn?._readyState === 1) {
    return cached.conn;
  }

  const disconnected = cached.conn && cached.conn?._readyState !== 1;
  if (!cached.promise || disconnected) {
    const opts = {
      bufferCommands: false,
      ...(isEnabled(process.env.CSFLE_ENABLED)
        ? { autoEncryption: await buildAutoEncryptionOptions(MONGO_URI) }
        : {}),
      ...(maxPoolSize ? { maxPoolSize } : {}),
      ...(minPoolSize ? { minPoolSize } : {}),
      ...(maxConnecting ? { maxConnecting } : {}),
      ...(maxIdleTimeMS ? { maxIdleTimeMS } : {}),
      ...(waitQueueTimeoutMS ? { waitQueueTimeoutMS } : {}),
      ...(autoIndex != undefined ? { autoIndex } : {}),
      ...(autoCreate != undefined ? { autoCreate } : {}),
      // useNewUrlParser: true,
      // useUnifiedTopology: true,
      // bufferMaxEntries: 0,
      // useFindAndModify: true,
      // useCreateIndex: true
    };
    const { autoEncryption: _autoEncryption, ...loggableOpts } = opts;
    logger.info('Mongo Connection options');
    logger.info(
      JSON.stringify(
        _autoEncryption ? { ...loggableOpts, autoEncryption: '[REDACTED]' } : loggableOpts,
        null,
        2,
      ),
    );
    mongoose.set('strictQuery', true);
    cached.promise = mongoose.connect(MONGO_URI, opts).then((mongoose) => {
      return mongoose;
    });
  }
  cached.conn = await cached.promise;

  if (
    isEnabled(process.env.CSFLE_ENABLED) &&
    isEnabled(process.env.CSFLE_AUTO_MIGRATE) &&
    !cached.migrationRan
  ) {
    cached.migrationRan = true;
    try {
      await runStartupMigration(MONGO_URI);
    } catch (err) {
      cached.migrationRan = false;
      throw err;
    }
  }

  return cached.conn;
}

module.exports = {
  connectDb,
};
