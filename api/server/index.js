/* ----------------------------------------------------------------------------
 * DISABLED: process.env.PROXY is now the routing mechanism.
 *
 * The custom SOCKS5 interceptor that follows was a poor reinvention of
 * LibreChat's built-in PROXY support. With PROXY=http://127.0.0.1:1056 set in
 * the environment, LibreChat's axios/undici clients route automatically
 * through Tailscale's HTTP proxy (the `--outbound-http-proxy-listen` flag in
 * tailscale-run). No code-side hijack needed.
 *
 * The code below is COMMENTED OUT (not deleted) as a safety net for one
 * deploy cycle. If PROXY routing has issues in production, uncommenting this
 * block restores the manual SOCKS routing while we debug. After we're
 * confident PROXY is stable, delete this whole block in a follow-up PR.
 *
 * What this block did before disable:
 *   - constructed an undici.Agent with a custom SOCKS5 `connect` function
 *   - hijacked globalThis.fetch so 100.100.x.x requests went through it
 *   - classified SOCKS failures, retried transients, classified errors
 * ------------------------------------------------------------------------- */
/* === DISABLED CODE START (commented out) === */
/*
const { Agent } = require('undici');
const { SocksClient } = require('socks');

const SOCKS_PROXY_HOST = process.env.SOCKS_PROXY_HOST || '127.0.0.1';
const SOCKS_PROXY_PORT = parseInt(process.env.SOCKS_PROXY_PORT || '1055', 10);

const socksDispatcher = new Agent({
  connect: async ({ hostname, port }) => {
    // Defensive parse. undici *should* always pass a valid hostname (string)
    // and port (number) here, but if it ever passes something malformed --
    // undefined, empty string, or a URL object instead of a string -- we
    // surface a clean, classified error instead of letting it crash out of
    // undici internals and trip our uncaughtException handler (which would
    // process.exit(1) the whole chat server). Previously this fired as
    // `error: There was an uncaught error: An invalid destination host was
    // provided.` after every SOCKS hiccup, killing the container.
    const host = typeof hostname === 'string'
      ? hostname
      : (hostname && typeof hostname === 'object' && typeof hostname.hostname === 'string'
          ? hostname.hostname
          : '');
    const portNum = typeof port === 'number' && port > 0
      ? port
      : (typeof port === 'string' && port.length > 0
          ? parseInt(port, 10)
          : 0);
    if (!host || !portNum) {
      const err = new Error('Invalid destination host: hostname=' + JSON.stringify(hostname) + ' port=' + JSON.stringify(port));
      err.code = 'INVALID_DESTINATION';
      throw err;
    }
    const { socket } = await SocksClient.createConnection({
      proxy: { host: SOCKS_PROXY_HOST, port: SOCKS_PROXY_PORT, type: 5 },
      command: 'connect',
      destination: { host: host, port: portNum },
    });
    return socket;
  },
});

const originalFetch = globalThis.fetch;

console.log(
  '[SOCKS] Tailscale SOCKS5 interceptor installed. Proxy=socks5://' +
    SOCKS_PROXY_HOST + ':' + SOCKS_PROXY_PORT +
    ' via undici.Agent | Trigger: URLs containing "100.100."',
);

function classifySocksError(err) {
  const code = err?.code || err?.cause?.code || '';
  const msg = err?.message || err?.cause?.message || '';
  if (/SOCKS5|Socks5/i.test(msg)) return 'SOCKS_HANDSHAKE';
  if (code === 'ECONNREFUSED') return 'SOCKS_REFUSED';
  if (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return 'TIMEOUT';
  }
  if (code === 'ENOTFOUND') return 'DNS';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'NET_UNREACHABLE';
  if (code === 'ECONNRESET') return 'CONN_RESET';
  if (code === 'EPIPE') return 'PIPE';
  if (/TLS|certificate|handshake/i.test(msg)) return 'TLS';
  return 'UNKNOWN';
}

function isTransientSocksFailure(err) {
  const code = err?.code || err?.cause?.code || '';
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

async function fetchThroughSocks(url, fetchOptions) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await originalFetch(url, { ...fetchOptions, dispatcher: socksDispatcher });
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isTransientSocksFailure(err)) {
        const backoffMs = 750;
        console.warn(
          '[SOCKS] retrying in ' + backoffMs + 'ms after transient ' +
          (err?.cause?.code || err?.code || '<unknown>') +
          ' on attempt ' + (attempt + 1),
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

globalThis.fetch = async (url, options = {}) => {
  if (url && typeof url.toString === 'function' && url.toString().includes('100.100.')) {
    const urlStr = url.toString();
    const start = Date.now();
    let dest = urlStr;
    try {
      const u = new URL(urlStr);
      dest = u.host + u.pathname;
    } catch (_) { }
    console.log('[SOCKS] → dest=' + dest + ' full=' + urlStr);
    try {
      const response = await fetchThroughSocks(url, options);
      const ms = Date.now() - start;
      console.log('[SOCKS] ← OK ' + response.status + ' ' + dest + ' (' + ms + 'ms)');
      return response;
    } catch (err) {
      const ms = Date.now() - start;
      const category = classifySocksError(err);
      const code = err?.code || '<none>';
      const causeCode = err?.cause?.code || '<none>';
      const causeMsg = (err?.cause?.message || '<none>').slice(0, 200);
      console.error(
        '[SOCKS] ← FAILED [' + category + '] ' + dest +
        ' (' + ms + 'ms)' +
        ' uptime=' + Math.round(process.uptime()) + 's' +
        ' code=' + code +
        ' cause.code=' + causeCode +
        ' cause.msg=' + causeMsg,
      );
      if (category === 'SOCKS_HANDSHAKE') {
        console.error(
          '[SOCKS]    HINT: SOCKS5 protocol negotiation with 127.0.0.1:1055 failed.',
        );
      }
      if (category === 'CONN_RESET') {
        console.error(
          '[SOCKS]    HINT: Connection reset mid-flight (Tailscale wgengine reconfig).',
        );
      }
      throw err;
    }
  }
  return originalFetch(url, options);
};
*/

/* === DISABLED CODE END === */

// PROXY-based routing is now active. LibreChat reads process.env.PROXY and
// automatically routes all HTTP traffic (axios, undici fetch) through the
// configured proxy. With PROXY=http://127.0.0.1:1056, that's Tailscale's
// HTTP proxy, which tunnels HTTPS via the tailnet to AjraSakha-Agent on
// annam-4. No code-level hijack needed; no SOCKS5 setup at the JS layer.
console.log('[PROXY] Tailscale HTTP proxy routing active. PROXY=' + (process.env.PROXY || '<unset>') + '. Replaces the SOCKS interceptor (now commented out above).');

require('dotenv').config();
const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
const cors = require('cors');
const axios = require('axios');
const express = require('express');
const passport = require('passport');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { logger } = require('@librechat/data-schemas');
const mongoSanitize = require('express-mongo-sanitize');
const {
  isEnabled,
  ErrorController,
  performStartupChecks,
  handleJsonParseError,
  initializeFileStorage,
  GenerationJobManager,
  createStreamServices,
} = require('@librechat/api');
const { connectDb, indexSync } = require('~/db');
const initializeOAuthReconnectManager = require('./services/initializeOAuthReconnectManager');
const createValidateImageRequest = require('./middleware/validateImageRequest');
const { jwtLogin, ldapLogin, passportLogin } = require('~/strategies');
const { updateInterfacePermissions } = require('~/models/interface');
const { checkMigrations } = require('./services/start/migration');
const initializeMCPs = require('./services/initializeMCPs');
const configureSocialLogins = require('./socialLogins');
const { getAppConfig } = require('./services/Config');
const staticCache = require('./utils/staticCache');
const noIndex = require('./middleware/noIndex');
const { seedDatabase } = require('~/models');
const routes = require('./routes');

const { PORT, HOST, ALLOW_SOCIAL_LOGIN, DISABLE_COMPRESSION, TRUST_PROXY } = process.env ?? {};

/**
 * Tailscale Network Status Check
 * ----------------------------------------------------------------------------
 * Runs `tailscale status` *before* the server starts so we can see every
 * machine currently in the Tailscale network (this node + peers).
 *
 * Configuration:
 *   - SKIP_TAILSCALE_STATUS=true   -> skip the check entirely (useful in CI / Cloud Run)
 *   - TAILSCALE_BIN=/path/to/bin   -> override the binary path (default: `tailscale`)
 *
 * The check is non-fatal: if Tailscale is not installed or the command fails,
 * the server still starts and a warning is logged.
 */
const { execSync } = require('child_process');

/**
 * Resolve the directory used to drop the on-disk proof file. This lets the
 * operator `cat` the file even when stdout/stderr are detached (PM2, nohup,
 * Cloud Run, etc.).
 *
 * Priority:
 *   1. LIBRECHAT_LOG_DIR  -> use it
 *   2. /app/logs          -> Docker convention used elsewhere in the codebase
 *   3. /tmp               -> safe fallback for local dev / CI
 */
function resolveTailscaleProofDir() {
  if (process.env.LIBRECHAT_LOG_DIR) {
    try {
      fs.mkdirSync(process.env.LIBRECHAT_LOG_DIR, { recursive: true });
      return process.env.LIBRECHAT_LOG_DIR;
    } catch (_) {
      /* fall through */
    }
  }
  if (process.cwd() === '/app') {
    try {
      fs.mkdirSync('/app/logs', { recursive: true });
      return '/app/logs';
    } catch (_) {
      /* fall through */
    }
  }
  return '/tmp';
}

const TAILSCALE_PROOF_PATH = path.join(resolveTailscaleProofDir(), 'tailscale-status.log');

function writeTailscaleProof(contents) {
  try {
    fs.writeFileSync(TAILSCALE_PROOF_PATH, `${contents}\n`, { flag: 'a', encoding: 'utf8' });
  } catch (err) {
    // Don't crash the server if the file can't be written.
    console.warn('[Tailscale] Could not write proof file:', TAILSCALE_PROOF_PATH, err.message);
  }
}

function checkTailscaleStatus() {
  // Use console.* directly so the output is visible regardless of NODE_ENV /
  // winston log level (production defaults to level=warn and would otherwise
  // drop the happy-path info messages).
  const log = (...args) => console.log('[Tailscale]', ...args);
  const warn = (...args) => console.warn('[Tailscale]', ...args);

  // Always write a STARTED marker first. If this file exists after startup,
  // it proves the script ran -- even if stdout was redirected away.
  const startedAt = new Date().toISOString();
  writeTailscaleProof(
    `\n[${startedAt}] TAILSCALE CHECK STARTED (pid=${process.pid}, node=${process.version}, cwd=${process.cwd()})`,
  );
  log(`Proof file: ${TAILSCALE_PROOF_PATH}`);

  if (isEnabled(process.env.SKIP_TAILSCALE_STATUS)) {
    log('Status check skipped via SKIP_TAILSCALE_STATUS=true');
    writeTailscaleProof(`[${new Date().toISOString()}] SKIPPED via SKIP_TAILSCALE_STATUS=true`);
    return;
  }

  const binary = process.env.TAILSCALE_BIN || 'tailscale';

  log('========================================');
  log('Checking network status...');
  log('========================================');

  try {
    const output = execSync(`${binary} status`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      encoding: 'utf8',
    });

    const lines = (output || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      warn('`tailscale status` returned no output.');
      writeTailscaleProof(`[${new Date().toISOString()}] RESULT: empty (0 peers)`);
    } else {
      log(`Discovered ${lines.length} network entries:\n${output}`);
      writeTailscaleProof(
        `[${new Date().toISOString()}] RESULT: success (${lines.length} peers)\n${output.trimEnd()}`,
      );
    }
  } catch (error) {
    const stderr = error?.stderr ? error.stderr.toString().trim() : '';
    const message = error?.message ? error.message.toString().trim() : '';
    const reason =
      `Unable to run "${binary} status". ` +
      'Continuing server startup. ' +
      'If this is unexpected, install Tailscale on the host or set SKIP_TAILSCALE_STATUS=true.\n' +
      (stderr ? `stderr: ${stderr}\n` : '') +
      (message ? `message: ${message}` : '');
    warn(reason);
    writeTailscaleProof(`[${new Date().toISOString()}] RESULT: error\n${reason}`);
  } finally {
    log('========================================');
    writeTailscaleProof(`[${new Date().toISOString()}] TAILSCALE CHECK FINISHED`);
  }
}

checkTailscaleStatus();

// Allow PORT=0 to be used for automatic free port assignment
const port = isNaN(Number(PORT)) ? 3080 : Number(PORT);
const host = HOST || 'localhost';
const trusted_proxy = Number(TRUST_PROXY) || 1; /* trust first proxy by default */

const app = express();

const startServer = async () => {
  if (typeof Bun !== 'undefined') {
    axios.defaults.headers.common['Accept-Encoding'] = 'gzip';
  }
  await connectDb();

  logger.info('Connected to MongoDB');
  indexSync().catch((err) => {
    logger.error('[indexSync] Background sync failed:', err);
  });

  app.disable('x-powered-by');
  app.set('trust proxy', trusted_proxy);

  await seedDatabase();
  const appConfig = await getAppConfig();

  // Boot-time configuration dump for tailnet diagnostics. Logs which endpoints
  // are configured and which URLs they resolved to. Catches the classic bug
  // where a commented-out `speech:` block in librechat.config.yaml leaves the
  // TTS/STT URLs as literal `undefined`, and where a `titleEndpoint` references
  // an endpoint that doesn't exist. See TAILSCALE.md for context.
  try {
    const customEndpoints = appConfig?.endpoints?.custom || [];
    console.log('[CONFIG] === Boot config dump (tailnet diagnostics) ===');
    console.log('[CONFIG] NODE_ENV=' + (process.env.NODE_ENV || '<unset>'));
    console.log('[CONFIG] CONFIG_PATH=' + (process.env.CONFIG_PATH || '<unset>'));
    console.log('[CONFIG] endpoints.custom count=' + customEndpoints.length);
    customEndpoints.forEach((ep, i) => {
      console.log('[CONFIG]   [' + i + '] name=' + ep.name + ' baseURL=' + (ep.baseURL || '<unset>') +
        ' titleEndpoint=' + (ep.titleEndpoint || '<unset>') +
        ' titleModel=' + (ep.titleModel || '<unset>'));
    });
    const speech = appConfig?.speech;
    console.log('[CONFIG] speech.stt.openai.url=' + (speech?.stt?.openai?.url || '<unset>'));
    console.log('[CONFIG] speech.tts.openai.url=' + (speech?.tts?.openai?.url || '<unset>'));
    console.log('[CONFIG] === End boot config dump ===');
    if (!speech?.stt?.openai?.url || !speech?.tts?.openai?.url) {
      console.warn('[CONFIG] WARNING: speech.stt.openai.url or speech.tts.openai.url is unset. ' +
        'TTS/STT requests will fail with "url is undefined". Uncomment the `speech:` block in librechat.config.yaml.');
    }
    customEndpoints.forEach((ep) => {
      if (ep.titleEndpoint && !customEndpoints.find((e) => e.name === ep.titleEndpoint)) {
        console.warn('[CONFIG] WARNING: endpoint "' + ep.name + '" has titleEndpoint="' + ep.titleEndpoint +
          '" but no such endpoint is configured. Title generation will fall back to the default endpoint.');
      }
    });
  } catch (e) {
    console.warn('[CONFIG] Boot config dump failed:', e.message);
  }

  initializeFileStorage(appConfig);
  await performStartupChecks(appConfig);
  await updateInterfacePermissions(appConfig);

  const indexPath = path.join(appConfig.paths.dist, 'index.html');
  let indexHTML = fs.readFileSync(indexPath, 'utf8');

  // In order to provide support to serving the application in a sub-directory
  // We need to update the base href if the DOMAIN_CLIENT is specified and not the root path
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

  app.get('/health', (_req, res) => res.status(200).send('OK'));

  // Test external connectivity
  app.get('/api/test-external', async (req, res) => {
    try {
      const response = await axios.get('https://jsonplaceholder.typicode.com/todos/1');
      res.json({ success: true, data: response.data });
    } catch (error) {
      logger.error('[test-external] Error:', error.message);
      res.json({ success: false, error: error.message, code: error.code });
    }
  });

  /* Middleware */
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
    console.warn('Response compression has been disabled via DISABLE_COMPRESSION.');
  }

  app.use(staticCache(appConfig.paths.dist));
  app.use(staticCache(appConfig.paths.fonts));
  app.use(staticCache(appConfig.paths.assets));

  if (!ALLOW_SOCIAL_LOGIN) {
    console.warn('Social logins are disabled. Set ALLOW_SOCIAL_LOGIN=true to enable them.');
  }

  /* OAUTH */
  app.use(passport.initialize());
  passport.use(jwtLogin());
  passport.use(passportLogin());

  /* LDAP Auth */
  if (process.env.LDAP_URL && process.env.LDAP_USER_SEARCH_BASE) {
    passport.use(ldapLogin);
  }

  if (isEnabled(ALLOW_SOCIAL_LOGIN)) {
    await configureSocialLogins(app);
  }

  app.use('/oauth', routes.oauth);
  /* API Endpoints */
  app.use('/api/auth', routes.auth);
  app.use('/api/actions', routes.actions);
  app.use('/api/keys', routes.keys);
  app.use('/api/user', routes.user);
  app.use('/api/search', routes.search);
  app.use('/api/messages', routes.messages);
  app.use('/api/convos', routes.convos);
  app.use('/api/presets', routes.presets);
  app.use('/api/prompts', routes.prompts);
  app.use('/api/categories', routes.categories);
  app.use('/api/endpoints', routes.endpoints);
  app.use('/api/balance', routes.balance);
  app.use('/api/models', routes.models);
  app.use('/api/config', routes.config);
  app.use('/api/assistants', routes.assistants);
  app.use('/api/files', await routes.files.initialize());
  app.use('/images/', createValidateImageRequest(appConfig.secureImageLinks), routes.staticRoute);
  app.use('/api/share', routes.share);
  app.use('/api/roles', routes.roles);
  app.use('/api/agents', routes.agents);
  app.use('/api/banner', routes.banner);
  app.use('/api/memories', routes.memories);
  app.use('/api/permissions', routes.accessPermissions);

  app.use('/api/tags', routes.tags);
  app.use('/api/mcp', routes.mcp);
  app.use('/api/webhooks', routes.webhooks);
  app.use('/api/feedbacks', routes.feedbacks);
  app.use('/api/push', routes.push);
  app.use('/api/notifications', routes.notifications);
  app.use('/api/locations', routes.locations);
  app.use('/api/langgraph', routes.langgraph);
  app.use('/api/diagnostics', routes.diagnostics);
  app.use('/api/crops', routes.crops);
  app.use('/api/answers', routes.answers);

  app.use(ErrorController);

  app.use((req, res) => {
    res.set({
      'Cache-Control': process.env.INDEX_CACHE_CONTROL || 'no-cache, no-store, must-revalidate',
      Pragma: process.env.INDEX_PRAGMA || 'no-cache',
      Expires: process.env.INDEX_EXPIRES || '0',
    });

    const lang = req.cookies.lang || req.headers['accept-language']?.split(',')[0] || 'en-US';
    const saneLang = lang.replace(/"/g, '&quot;');
    let updatedIndexHtml = indexHTML.replace(/lang="en-US"/g, `lang="${saneLang}"`);

    res.type('html');
    res.send(updatedIndexHtml);
  });

  app.listen(port, host, async (err) => {
    if (err) {
      logger.error('Failed to start server:', err);
      process.exit(1);
    }

    if (host === '0.0.0.0') {
      logger.info(
        `Server listening on all interfaces at port ${port}. Use http://localhost:${port} to access it`,
      );
    } else {
      logger.info(`Server listening at http://${host == '0.0.0.0' ? 'localhost' : host}:${port}`);
    }

    await initializeMCPs();
    await initializeOAuthReconnectManager();
    await checkMigrations();

    // Configure stream services (auto-detects Redis from USE_REDIS env var)
    const streamServices = createStreamServices();
    GenerationJobManager.configure(streamServices);
    GenerationJobManager.initialize();
  });
};

startServer();

let messageCount = 0;
process.on('uncaughtException', (err) => {
  // INVALID_DESTINATION errors come from our SOCKS interceptor when undici
  // passes a malformed hostname/port. Swallow them: they're already surfaced
  // to the caller as a normal fetch error (our [SOCKS] interceptor logs the
  // full context), and we don't want them to tear down the whole chat server.
  if (err && (err.code === 'INVALID_DESTINATION' || /invalid destination/i.test(err.message || ''))) {
    console.error('[uncaughtException] swallowed INVALID_DESTINATION:', err.message);
    return;
  }

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

/** Export app for easier testing purposes */
module.exports = app;
