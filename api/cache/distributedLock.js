const { ioredisClient, createDistributedLock } = require('@librechat/api');

/** The one `DistributedLock` for this process. Redis-backed when `ioredisClient` is set; otherwise an in-process lock that coordinates only callers holding this instance. */
const distributedLock = createDistributedLock({ redisClient: ioredisClient });

module.exports = { distributedLock };
