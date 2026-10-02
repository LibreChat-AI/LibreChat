require('../config/credentials');
/**
 * The primary kills every worker and then force-exits the whole cluster this long after its own
 * shutdown signal, regardless of what the workers are still doing.
 */
const CLUSTER_FORCE_EXIT_MS = 10_000;
/** Absolute time the primary will force-exit the cluster, propagated to this worker over IPC. */
let clusterShutdownDeadlineAt = null;

const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
const cluster = require('cluster');
const Redis = require('ioredis');
const cors = require('cors');
const axios = require('axios');
const express = require('express');
const mongoose = require('mongoose');
const passport = require('passport');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const mongoSanitize = require('express-mongo-sanitize');
const {
  isEnabled,
  issueCsp,
  apiNotFound,
  applyCspNonce,
  createCspPolicy,
  shellCacheHeaders,
  escapeHtmlAttribute,
  ErrorController,
  QUERY_DEVTOOLS_HEADER,
  createSecurityHeaders,
  performStartupChecks,
  handleJsonParseError,
  initializeFileStorage,
  loadToolApprovalHooks,
  maybeInjectQueryDevtoolsBootstrap,
  injectConfiguredFooterBootstrap,
  preAuthTenantMiddleware,
  requestContextMiddleware,
  configureServerTimeouts,
  setupGracefulShutdown,
  registerShutdownTask,
  getClusterShutdownBudgetMs,
  registerBackgroundTaskShutdown,
  configureMessageFilterRegexValidator,
  configureFileConfigRegexEngine,
  configureAgentEventRuntime,
  GenerationJobManager,
  createAgentEventTerminalHandler,
  startCodeEnvironmentLifecycleReconciler,
  waitForKeyvRedisClient,
  createCodeApiUploadRegistry,
  cacheConfig,
  createClusteredFileSweep,
} = require('@librechat/api');
const { connectDb, indexSync } = require('~/db');
const initializeOAuthReconnectManager = require('./services/initializeOAuthReconnectManager');
const { capabilityContextMiddleware } = require('./middleware/roles/capabilities');
const createValidateImageRequest = require('./middleware/validateImageRequest');
const { startExpiredFileSweep } = require('./services/Files/process');
const { initializeGitHubSkillSync } = require('./services/Skills/sync');
const { initializeAgentTriggerService } = require('./services/Agents/triggers');
const { resumeAgentEventDetachedAction } = require('./services/Agents/detachedActionResume');
const {
  recordExpiredScheduleApproval,
  initializeScheduleErasureSweep,
} = require('./services/Schedules');
const { configureSubagentTaskRouting } = require('./services/Endpoints/agents/subagentThreadStore');
const { jwtLogin, ldapLogin, passportLogin } = require('~/strategies');
const { updateInterfacePermissions: updateInterfacePerms } = require('@librechat/api');
const {
  getRoleByName,
  updateAccessPermissions,
  seedDatabase,
  sweepOrphanedPreviews,
} = require('~/models');
const { checkMigrations } = require('./services/start/migration');
const initializeMCPs = require('./services/initializeMCPs');
const configureSocialLogins = require('./socialLogins');
const createSpaFallback = require('./utils/fallback');
const { getAppConfig } = require('./services/Config');
const staticCache = require('./utils/staticCache');
const optionalJwtAuth = require('./middleware/optionalJwtAuth');
const noIndex = require('./middleware/noIndex');
const agentEventMethods = require('~/models');

/** Route admin file-config MIME patterns through a linear-time engine (ReDoS-safe) on upload. */
configureFileConfigRegexEngine();

/** Reject messageFilter PII patterns the RE2 runtime engine cannot compile, at config load. */
configureMessageFilterRegexValidator();

const { PORT, HOST, ALLOW_SOCIAL_LOGIN, DISABLE_COMPRESSION, TRUST_PROXY } = process.env ?? {};

/** Allow PORT=0 to be used for automatic free port assignment */
const port = isNaN(Number(PORT)) ? 3080 : Number(PORT);
const host = HOST || 'localhost';
const trusted_proxy = Number(TRUST_PROXY) || 1;

/** Number of worker processes to spawn (simulating multiple pods) */
const workers = Number(process.env.CLUSTER_WORKERS) || 4;

/** Helper to wrap log messages for better visibility */
const wrapLogMessage = (msg) => {
  return `\n${'='.repeat(50)}\n${msg}\n${'='.repeat(50)}`;
};

/**
 * Flushes the Redis cache on startup
 * This ensures a clean state for testing multi-pod MCP connection issues
 */
const flushRedisCache = async () => {
  /** Skip cache flush if Redis is not enabled */
  if (!isEnabled(process.env.USE_REDIS)) {
    logger.info('Redis is not enabled, skipping cache flush');
    return;
  }

  const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
  };

  if (process.env.REDIS_PASSWORD) {
    redisConfig.password = process.env.REDIS_PASSWORD;
  }

  /** Handle Redis Cluster configuration */
  if (isEnabled(process.env.USE_REDIS_CLUSTER) || process.env.REDIS_URI?.includes(',')) {
    logger.info('Detected Redis Cluster configuration');
    const uris = process.env.REDIS_URI?.split(',').map((uri) => {
      const url = new URL(uri.trim());
      return {
        host: url.hostname,
        port: parseInt(url.port || '6379', 10),
      };
    });
    const redis = new Redis.Cluster(uris, {
      redisOptions: {
        password: process.env.REDIS_PASSWORD,
      },
    });

    try {
      logger.info('Attempting to connect to Redis Cluster...');
      await redis.ping();
      logger.info('Connected to Redis Cluster. Executing flushall...');
      const result = await Promise.race([
        redis.flushall(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Flush timeout')), 10000)),
      ]);
      logger.info('Redis Cluster cache flushed successfully', { result });
    } catch (err) {
      logger.error('Error while flushing Redis Cluster cache:', err);
      throw err;
    } finally {
      redis.disconnect();
    }
    return;
  }

  /** Handle single Redis instance */
  const redis = new Redis(redisConfig);

  try {
    logger.info('Attempting to connect to Redis...');
    await redis.ping();
    logger.info('Connected to Redis. Executing flushall...');
    const result = await Promise.race([
      redis.flushall(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Flush timeout')), 5000)),
    ]);
    logger.info('Redis cache flushed successfully', { result });
  } catch (err) {
    logger.error('Error while flushing Redis cache:', err);
    throw err;
  } finally {
    redis.disconnect();
  }
};

/**
 * Master process
 * Manages worker processes and handles graceful shutdowns
 */
if (cluster.isMaster) {
  logger.info(wrapLogMessage(`Master ${process.pid} is starting...`));
  logger.info(`Spawning ${workers} workers to simulate multi-pod environment`);

  let activeWorkers = 0;
  const listeningWorkers = new Set();
  let retentionSweepWorkerId = null;
  const startTime = Date.now();
  let shuttingDown = false;
  let remainingShutdownWorkers = 0;

  const assignRetentionSweepWorker = () => {
    if (retentionSweepWorkerId && cluster.workers[retentionSweepWorkerId]) {
      return;
    }

    const connectedWorkers = Object.values(cluster.workers).filter(
      (worker) => worker && worker.isConnected(),
    );
    const availableWorkers = connectedWorkers.filter((worker) => listeningWorkers.has(worker.id));
    const workerPool = availableWorkers.length > 0 ? availableWorkers : connectedWorkers;
    const retentionSweepWorker = workerPool[workerPool.length - 1];
    if (!retentionSweepWorker) {
      return;
    }

    retentionSweepWorkerId = retentionSweepWorker.id;
    logger.info(
      wrapLogMessage(`Worker ${retentionSweepWorker.process.pid} assigned to file-retention sweep`),
    );
    retentionSweepWorker.send({ type: 'file-retention-sweep-worker' });
  };

  /** Flush Redis cache before starting workers */
  flushRedisCache()
    .then(() => {
      logger.info('Cache flushed, forking workers...');
      for (let i = 0; i < workers; i++) {
        cluster.fork();
      }
    })
    .catch((err) => {
      logger.error('Unable to flush Redis cache, not forking workers:', err);
      process.exit(1);
    });

  /** Track worker lifecycle */
  cluster.on('online', (worker) => {
    activeWorkers++;
    const uptime = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(
      `Worker ${worker.process.pid} is online (${activeWorkers}/${workers}) after ${uptime}s`,
    );

    /** Assign one worker for process-wide background jobs */
    if (activeWorkers === workers) {
      logger.info(wrapLogMessage(`All ${workers} workers are online`));
    }
  });

  cluster.on('listening', (worker) => {
    listeningWorkers.add(worker.id);
    if (
      listeningWorkers.size === workers ||
      (!retentionSweepWorkerId && activeWorkers >= workers)
    ) {
      assignRetentionSweepWorker();
    }
  });

  cluster.on('exit', (worker, code, signal) => {
    activeWorkers--;
    listeningWorkers.delete(worker.id);
    if (worker.id === retentionSweepWorkerId) {
      retentionSweepWorkerId = null;
      assignRetentionSweepWorker();
    }
    logger.error(
      `Worker ${worker.process.pid} died (${activeWorkers}/${workers}). Code: ${code}, Signal: ${signal}`,
    );
    if (shuttingDown) {
      remainingShutdownWorkers = Math.max(0, remainingShutdownWorkers - 1);
      if (remainingShutdownWorkers === 0) {
        process.exit(0);
      }
      return;
    }
    logger.info('Starting a new worker to replace it...');
    cluster.fork();
  });

  /**
   * Deliver the absolute deadline, then SIGTERM only once the worker has acknowledged it.
   * IPC is asynchronous and worker.kill() is immediate, so without the acknowledgement a
   * busy worker can enter its shutdown handler before the deadline arrives and fall back to
   * a worker-local estimate the primary will not honor. Bounded so a stalled worker cannot
   * hold the others.
   */
  const signalWorkerAfterDeadlineAck = (worker, deadlineAt) => {
    let signaled = false;
    const onMessage = (msg) => {
      if (msg != null && msg.type === 'cluster-shutdown-ack') {
        signal();
      }
    };
    /** A closed IPC channel is reported asynchronously, not thrown from send(); without a
     *  listener it reaches the global uncaughtException handler and exits the primary,
     *  killing every other worker before it can record its drain. */
    const onError = (err) => {
      logger.warn('Worker IPC error during the shutdown handoff; treating it as gone:', err);
      signal();
    };
    const signal = () => {
      if (signaled) {
        return;
      }
      signaled = true;
      worker.off('message', onMessage);
      worker.off('error', onError);
      try {
        worker.kill();
      } catch (err) {
        logger.debug('Worker already gone before SIGTERM:', err);
      }
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    /** Deliberately no separate timeout. SIGTERM is sent only after the worker has recorded
     *  the deadline; a worker that never acknowledges is ended by the primary's own
     *  force-exit, the one deadline it can honor. Signaling sooner would let a stalled
     *  worker's SIGTERM handler run before the queued deadline message and fall back to a
     *  local budget the primary will not honor, the exact case this handoff exists for.
     *  Handshakes are per worker, so a stalled one holds no other. */
    worker.send({ type: 'cluster-shutdown', deadlineAt }, (err) => {
      if (err) {
        onError(err);
      }
    });
  };

  /** Graceful shutdown on SIGTERM/SIGINT */
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('Master received shutdown signal, terminating workers...');
    const liveWorkers = Object.values(cluster.workers).filter(Boolean);
    remainingShutdownWorkers = liveWorkers.length;
    if (remainingShutdownWorkers === 0) {
      process.exit(0);
      return;
    }
    /** Workers derive their settlement budget from THIS deadline — not from their own
     *  coordinator, and not from whenever their signal handler happened to run. */
    const deadlineAt = Date.now() + CLUSTER_FORCE_EXIT_MS;
    for (const worker of liveWorkers) {
      signalWorkerAfterDeadlineAck(worker, deadlineAt);
    }
    setTimeout(() => {
      logger.info('Forcing shutdown after timeout');
      process.exit(0);
    }, CLUSTER_FORCE_EXIT_MS);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  /**
   * Worker process
   * Each worker runs a full Express server instance
   */
  const app = express();
  app.locals.codeApiUploadRegistry = createCodeApiUploadRegistry();
  // The clustered entrypoint deliberately does not arm the v1 schedule engine,
  // but an already-fired scheduled generation can still reach HITL here. Settle
  // its durable run when the generic approval runtime expires it.
  GenerationJobManager.setApprovalExpiredHandler(recordExpiredScheduleApproval);
  GenerationJobManager.setTerminalHostActionHandler(
    createAgentEventTerminalHandler(agentEventMethods, {
      resumeDetachedAction: resumeAgentEventDetachedAction,
    }),
  );
  GenerationJobManager.initialize();
  // Stop active generations and close their SSE streams while the HTTP server drains.
  registerShutdownTask(
    'generation job manager prepare',
    () => GenerationJobManager.prepareForShutdown(),
    {
      phase: 'pre-drain',
      priority: 100,
    },
  );
  /** Spend the shutdown budget that is actually left waiting for open provider executions to
   *  record their own drains — but the budget this worker actually has is the primary's, not
   *  its own 60s coordinator: the primary force-exits the whole cluster CLUSTER_FORCE_EXIT_MS
   *  after signalling. Measure against that, and hold back a reserve for the tasks after this
   *  one. Abandoning an unrecorded drain fences the next generation permanently. */
  const CLUSTER_TEARDOWN_RESERVE_MS = 3_000;
  const clusterShutdownBudgetMs = () =>
    getClusterShutdownBudgetMs({
      deadlineAt: clusterShutdownDeadlineAt,
      forceExitMs: CLUSTER_FORCE_EXIT_MS,
    });
  const destroyGenerationJobManager = () => {
    const budgetMs = clusterShutdownBudgetMs();
    if (budgetMs == null) {
      return GenerationJobManager.destroy();
    }
    return GenerationJobManager.destroy({
      settlementBudgetMs: Math.max(0, budgetMs - CLUSTER_TEARDOWN_RESERVE_MS),
    });
  };
  // Tear down stream resources before shared caches and telemetry exporters shut down.
  registerShutdownTask('generation job manager', destroyGenerationJobManager, { priority: 100 });
  const expiredFileSweep = createClusteredFileSweep(cacheConfig.USE_REDIS, startExpiredFileSweep);
  const SCHEDULE_ENGINE_OPTIONAL_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);

  const rejectScheduleWritesUntilReady = (req, res, next) => {
    if (SCHEDULE_ENGINE_OPTIONAL_METHODS.has(req.method)) {
      return next();
    }
    return res.status(501).json({
      code: 'SCHEDULES_NOT_SUPPORTED',
      error: 'Scheduled chats are not available in clustered mode.',
    });
  };

  /** Handle inter-process messages from master */
  process.on('message', (msg) => {
    if (msg != null && msg.type === 'cluster-shutdown' && Number.isFinite(msg.deadlineAt)) {
      clusterShutdownDeadlineAt = msg.deadlineAt;
      /** The primary holds SIGTERM until this arrives, so the deadline is in place before
       *  the shutdown handler can run. */
      if (typeof process.send === 'function') {
        try {
          process.send({ type: 'cluster-shutdown-ack' });
        } catch (err) {
          logger.debug('Could not acknowledge the shutdown deadline to the primary:', err);
        }
      }
    }
  });
  process.on('message', (msg) => {
    if (msg.type === 'file-retention-sweep-worker') {
      logger.info(wrapLogMessage(`Worker ${process.pid} is assigned file-retention sweep`));
      expiredFileSweep.assign();
    }
  });
  const startServer = async () => {
    logger.info(`Worker ${process.pid} initializing...`);

    await waitForKeyvRedisClient();

    if (typeof Bun !== 'undefined') {
      axios.defaults.headers.common['Accept-Encoding'] = 'gzip';
    }

    /** Connect to MongoDB */
    await connectDb();
    logger.info(`Worker ${process.pid}: Connected to MongoDB`);
    startCodeEnvironmentLifecycleReconciler({ mongoose });

    /** Background index sync (non-blocking) */
    indexSync().catch((err) => {
      logger.error(`[Worker ${process.pid}][indexSync] Background sync failed:`, err);
    });

    // This entrypoint deliberately does not arm the schedule engine, but DELETE stays
    // open — so soft-deleted rows still accrue with no reconciler to erase them. Start
    // the erasure-ONLY sweep (Mongo is up, GenerationJobManager was initialized above):
    // it never claims, fires, advances, or infers owner death from a process-local
    // missing job, and its idempotent guard makes this safe once per worker.
    initializeScheduleErasureSweep();

    app.disable('x-powered-by');
    app.set('trust proxy', trusted_proxy);

    /* Registered ahead of every route so health checks carry the headers too. */
    const securityHeaders = createSecurityHeaders();
    if (securityHeaders) {
      app.use(securityHeaders);
    }

    if (isEnabled(process.env.TRUST_TENANT_HEADER)) {
      logger.warn(
        '[Security] TRUST_TENANT_HEADER is active. Ensure your reverse proxy strips and sets ' +
          'X-Tenant-Id — untrusted clients must not be able to supply it directly.',
      );
    } else if (isEnabled(process.env.TENANT_ISOLATION_STRICT)) {
      logger.warn(
        '[Security] TENANT_ISOLATION_STRICT is active while TRUST_TENANT_HEADER is disabled. ' +
          'Pre-authentication tenant headers will be ignored.',
      );
    }

    /** Seed database (idempotent) */
    await runAsSystem(seedDatabase);

    /* Mirrors `server/index.js`; `runAsSystem` for tenant-isolated File. */
    runAsSystem(sweepOrphanedPreviews).catch((err) => {
      logger.error('[sweepOrphanedPreviews] Background sweep failed:', err);
    });

    /** Initialize app configuration */
    const appConfig = await getAppConfig();
    initializeFileStorage(appConfig);
    initializeGitHubSkillSync(appConfig);
    // Register configured tool-approval policy hooks (mirrors the standard startup path).
    // Honors the `enabled` kill switch; hooks are base-config-only, registered process-wide.
    // Read from the BASE config specifically — `appConfig` above (getAppConfig() with no
    // principal) still merges DB `__base__` overrides, which must not drive which hook
    // modules load in every worker (matches api/server/index.js's baseOnly usage).
    const baseAppConfig = await getAppConfig({ baseOnly: true });
    await configureSubagentTaskRouting(baseAppConfig?.endpoints?.agents?.subagentActivity);
    registerBackgroundTaskShutdown({
      interruptGraceMs: baseAppConfig?.endpoints?.agents?.backgroundTasks?.shutdownInterruptGraceMs,
      getBudgetMs: clusterShutdownBudgetMs,
    });
    configureAgentEventRuntime(baseAppConfig?.endpoints?.agents?.eventDriven);
    const toolApproval = baseAppConfig?.endpoints?.agents?.toolApproval;
    await loadToolApprovalHooks(toolApproval?.enabled ? toolApproval.hooks : undefined, {
      basePath: path.resolve(__dirname, '../..'),
    });
    expiredFileSweep.configure({ appConfig, loadAppConfig: getAppConfig });
    await runAsSystem(async () => {
      await performStartupChecks(appConfig);
      await updateInterfacePerms({ appConfig, getRoleByName, updateAccessPermissions });
    });

    /* Route modules build their rate limiters as they load, so they load only after the
     * startup checks have applied `rateLimits` from librechat.yaml. */
    const routes = require('./routes');

    /** Load index.html for SPA serving */
    const indexPath = path.join(appConfig.paths.dist, 'index.html');
    let indexHTML = fs.readFileSync(indexPath, 'utf8');

    /** Support serving in subdirectory if DOMAIN_CLIENT is set */
    if (process.env.DOMAIN_CLIENT) {
      const clientUrl = new URL(process.env.DOMAIN_CLIENT);
      const baseHref = clientUrl.pathname.endsWith('/')
        ? clientUrl.pathname
        : `${clientUrl.pathname}/`;
      if (baseHref !== '/') {
        logger.info(`Setting base href to ${baseHref}`);
        indexHTML = indexHTML.replace(/base href="\/"/, `base href="${baseHref}"`);
      }
    }

    /* The composer lays out against whether a footer bar sits beneath it, and
       `/api/config` answers that only after it has painted. One shell serves
       every request, before there is a caller whose overrides could be resolved,
       so the answer is the deployment's base configuration, like index.js. */
    indexHTML = injectConfiguredFooterBootstrap(indexHTML, {
      customFooter: process.env.CUSTOM_FOOTER,
    });

    const cspPolicy = createCspPolicy();
    const shellCache = shellCacheHeaders(cspPolicy != null);

    const sendIndexHtml = (req, res) => {
      res.set(shellCache);
      res.vary(QUERY_DEVTOOLS_HEADER);

      const lang = req.cookies.lang || req.headers['accept-language']?.split(',')[0] || 'en-US';
      const saneLang = escapeHtmlAttribute(lang);
      let updatedIndexHtml = indexHTML.replace(/lang="en-US"/g, () => `lang="${saneLang}"`);
      updatedIndexHtml = maybeInjectQueryDevtoolsBootstrap(updatedIndexHtml, req);

      /* Nonce last: every injected script above must be stamped too. */
      if (cspPolicy) {
        const csp = issueCsp(cspPolicy);
        res.set(csp.headerName, csp.headerValue);
        updatedIndexHtml = applyCspNonce(updatedIndexHtml, csp.nonce);
      }

      res.type('html');
      res.send(updatedIndexHtml);
    };

    /** Health check endpoint */
    app.get('/health', (_req, res) => res.status(200).send('OK'));

    /** Middleware */
    app.use(requestContextMiddleware);
    app.use(noIndex);
    app.use(express.json({ limit: '3mb' }));
    app.use(express.urlencoded({ extended: true, limit: '3mb' }));

    app.use(handleJsonParseError);

    /**
     * Express 5 Compatibility: Make req.query writable for mongoSanitize
     * In Express 5, req.query is read-only by default, but express-mongo-sanitize needs to modify it
     */
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'query', {
        ...Object.getOwnPropertyDescriptor(req, 'query'),
        value: req.query,
        writable: true,
      });
      next();
    });

    app.use(mongoSanitize());
    app.use(cors());
    app.use(cookieParser());

    if (!isEnabled(DISABLE_COMPRESSION)) {
      app.use(compression());
    } else {
      logger.warn('Response compression has been disabled via DISABLE_COMPRESSION.');
    }

    app.get('/index.html', sendIndexHtml);
    app.use(staticCache(appConfig.paths.dist));
    app.use(staticCache(appConfig.paths.fonts));
    app.use(staticCache(appConfig.paths.assets));

    if (!ALLOW_SOCIAL_LOGIN) {
      logger.warn('Social logins are disabled. Set ALLOW_SOCIAL_LOGIN=true to enable them.');
    }

    /** OAUTH */
    app.use(passport.initialize());
    passport.use(jwtLogin());
    passport.use(passportLogin());

    /** LDAP Auth */
    if (process.env.LDAP_URL && process.env.LDAP_USER_SEARCH_BASE) {
      passport.use(ldapLogin);
    }

    if (isEnabled(ALLOW_SOCIAL_LOGIN)) {
      await configureSocialLogins(app, appConfig);
    }

    app.use(capabilityContextMiddleware);

    /** Routes */
    app.use('/oauth', preAuthTenantMiddleware, routes.oauth);
    app.use('/api/auth', preAuthTenantMiddleware, routes.auth);
    app.use('/api/insights', routes.insights);
    app.use('/api/admin', routes.adminAuth);
    app.use('/api/admin/skills', routes.adminSkills);
    app.use('/api/admin/code-environments', routes.adminCodeEnvironments);
    app.use('/api/code-environments', routes.codeEnvironments);
    app.use('/api/actions', routes.actions);
    app.use('/api/keys', routes.keys);
    app.use('/api/api-keys', routes.apiKeys);
    app.use('/api/user', routes.user);
    app.use('/api/search', routes.search);
    app.use('/api/messages', routes.messages);
    app.use('/api/convos', routes.convos);
    app.use('/api/presets', routes.presets);
    app.use('/api/projects', routes.projects);
    app.use('/api/prompts', routes.prompts);
    app.use('/api/skills', routes.skills);
    app.use('/api/categories', routes.categories);
    app.use('/api/endpoints', routes.endpoints);
    app.use('/api/balance', routes.balance);
    app.use('/api/models', routes.models);
    app.use('/api/config', preAuthTenantMiddleware, optionalJwtAuth, routes.config);
    app.use('/api/assistants', routes.assistants);
    app.use('/api/files', await routes.files.initialize());
    app.use(
      '/images/',
      createValidateImageRequest({
        secureImageLinks: appConfig.secureImageLinks,
      }),
      routes.staticRoute,
    );
    app.use('/api/share', preAuthTenantMiddleware, routes.share);
    app.use('/api/roles', routes.roles);
    app.use('/api/agents', routes.agents);
    app.use('/api/banner', routes.banner);
    app.use('/api/memories', routes.memories);
    app.use('/api/schedules', rejectScheduleWritesUntilReady, routes.schedules);
    app.use('/api/permissions', routes.accessPermissions);
    app.use('/api/tags', routes.tags);
    app.use('/api/mcp', routes.mcp);

    app.use('/api', routes.openapi);

    /** 404 for unmatched API routes */
    app.use('/api', apiNotFound);

    /** SPA fallback - serve index.html for all unmatched routes */
    app.use(createSpaFallback(sendIndexHtml));

    /** Error handler (must be last - Express identifies error middleware by its 4-arg signature) */
    app.use(ErrorController);

    /** Start listening on shared port (cluster will distribute connections) */
    const server = app.listen(port, host, async (err) => {
      if (err) {
        logger.error(`Worker ${process.pid} failed to start server:`, err);
        process.exit(1);
      }

      logger.info(
        `Worker ${process.pid} started: Server listening at http://${
          host == '0.0.0.0' ? 'localhost' : host
        }:${port}`,
      );

      /**
       * The listen callback is async, so any rejection from these awaits
       * would otherwise be detached from `startServer().catch(...)`. Without
       * explicit handling, the global `unhandledRejection` handler would
       * swallow init failures and leave the worker listening but only
       * partially initialized.
       */
      try {
        /** Initialize MCP servers and OAuth reconnection for this worker */
        await initializeMCPs();
        await initializeOAuthReconnectManager();
        await checkMigrations();
        await initializeAgentTriggerService({
          address: server.address(),
          completionResultBatchSize:
            baseAppConfig?.endpoints?.agents?.backgroundTasks?.completionResultBatchSize,
          idlePolling: baseAppConfig?.endpoints?.agents?.eventDriven?.idlePolling,
        });
      } catch (initErr) {
        logger.error(`Worker ${process.pid} post-listen initialization failed:`, initErr);
        process.exit(1);
      }
    });

    configureServerTimeouts(server);
    logger.info(`Worker ${process.pid} HTTP server timeout configuration`, {
      keepAliveTimeout: server.keepAliveTimeout,
      keepAliveTimeoutBuffer: server.keepAliveTimeoutBuffer,
      headersTimeout: server.headersTimeout,
      requestTimeout: server.requestTimeout,
    });
    setupGracefulShutdown(server);
  };

  startServer().catch((err) => {
    logger.error(`Failed to start worker ${process.pid}:`, err);
    process.exit(1);
  });

  /** Export app for testing purposes (only available in worker processes) */
  module.exports = app;
}

/**
 * Uncaught exception handler
 * Filters out known non-critical errors
 */
let messageCount = 0;
process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    logger.error('There was an uncaught error:', err);
  }

  if (err.message && err.message?.toLowerCase()?.includes('abort')) {
    logger.warn('There was an uncatchable abort error.');
    return;
  }

  if (err.message.includes('GoogleGenerativeAI')) {
    logger.warn(
      '\n\n`GoogleGenerativeAI` errors cannot be caught due to an upstream issue, see: https://github.com/google-gemini/generative-ai-js/issues/303',
    );
    return;
  }

  if (err.message.includes('fetch failed')) {
    if (messageCount === 0) {
      logger.warn('Meilisearch error, search will be disabled');
      messageCount++;
    }
    return;
  }

  if (err.message.includes('OpenAIError') || err.message.includes('ChatCompletionMessage')) {
    logger.error(
      '\n\nAn Uncaught `OpenAIError` error may be due to your reverse-proxy setup or stream configuration, or a bug in the `openai` node package.',
    );
    return;
  }

  if (err.stack && err.stack.includes('@librechat/agents')) {
    logger.error(
      '\n\nAn error occurred in the agents system. The error has been logged and the app will continue running.',
      {
        message: err.message,
        stack: err.stack,
      },
    );
    return;
  }

  process.exit(1);
});

/**
 * Unhandled promise rejection handler.
 *
 * Node 15+ terminates the process by default when a promise rejection is
 * unhandled. MCP OAuth reconnect storms and streamable-HTTP transport resets
 * can produce transient fire-and-forget rejections (ECONNRESET, token refresh
 * races) that are recoverable — the server should log and keep serving other
 * requests rather than silently crash under load.
 *
 * Non-Error reasons are forwarded as-is so structured payloads (e.g.
 * `{ code: "ECONNRESET", errno: -104 }`) survive instead of being collapsed to
 * "[object Object]" by `String()`.
 */
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error) {
    logger.error('Unhandled promise rejection. The app will continue running.', {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
      cause: reason.cause,
    });
    return;
  }
  logger.error('Unhandled promise rejection. The app will continue running.', { reason });
});
