const { logger, runAsSystem } = require('@librechat/data-schemas');
const { CacheKeys, SystemRoles } = require('librechat-data-provider');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const {
  loadJwtUser,
  isTokenRetired,
  getAuthUserDocCacheMode,
  AGENT_TRIGGER_SCOPE,
  continueAfterBearerRetirement,
  applyOpenIDSessionIdClaim,
  prefetchOpenIDBearerContext,
  resolveOpenIDLibreChatBearerVerdict,
  toOpenIDBearerPassportResult,
} = require('@librechat/api');
const { getUserById, updateUser } = require('~/models');
const getLogStores = require('~/cache/getLogStores');
const openIdSessions = require('~/server/services/OpenIDSessions');

const AGENT_TRIGGER_ADMISSION_PATHS = ['/api/agents/chat/agents', '/api/agents/chat/steer/deliver'];

/** A trigger-scoped bearer is deliberately useless outside the two internal
 * admission routes that the execution host calls. */
function isAgentTriggerAdmissionRequest(req) {
  if (req?.method !== 'POST' || req?.headers?.['x-lc-agent-trigger'] !== '1') {
    return false;
  }
  try {
    const pathname = new URL(req.originalUrl ?? req.url ?? '', 'http://localhost').pathname;
    return AGENT_TRIGGER_ADMISSION_PATHS.some((path) => pathname.endsWith(path));
  } catch {
    return false;
  }
}

// JWT strategy
const jwtLogin = () =>
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET,
      passReqToCallback: true,
    },
    async (req, payload, done) => {
      try {
        if (payload?.scope === AGENT_TRIGGER_SCOPE && !isAgentTriggerAdmissionRequest(req)) {
          done(null, false, { message: 'Agent trigger token is not valid for this endpoint' });
          return;
        }
        // Started alongside the user load below; authorizeOpenIDSession re-verifies identity.
        const sessionDeps = openIdSessions.sessionAuthorizationRef;
        const prefetch = prefetchOpenIDBearerContext(payload, sessionDeps);

        const { user, deleting, remember } = await loadJwtUser(payload?.id, {
          getUserById,
          cacheMode: getAuthUserDocCacheMode(),
          getCacheStore: () => getLogStores(CacheKeys.AUTH_USER_DOC),
        });
        if (deleting) {
          done(null, false, {
            message: 'Account deletion is in progress',
            code: 'ACCOUNT_DELETION_IN_PROGRESS',
          });
          return;
        }
        if (user) {
          return await continueAfterBearerRetirement(
            user,
            { issuedAt: payload?.iat, issuedAtMs: payload?.issuedAtMs },
            'jwt',
            payload?.id,
            done,
            (message) => logger.warn(message),
            async () => {
              user.id = user._id.toString();
              /** Absent on the full doc means local user; null skips getUserPrincipals' fallback lookup */
              user.idOnTheSource ??= null;

              const verdict = await resolveOpenIDLibreChatBearerVerdict(
                {
                  payload,
                  user,
                  clientId: openIdSessions.getOpenIdClientId(),
                  prefetch,
                },
                sessionDeps,
              );
              const bearerResult = toOpenIDBearerPassportResult(verdict, {
                userId: user.id,
                logger,
                label: 'jwtLogin',
              });
              if (!bearerResult.ok) {
                return done(...bearerResult.args);
              }

              const roleMissing = !user.role;
              if (roleMissing) {
                user.role = SystemRoles.USER;
                await runAsSystem(() => updateUser(user.id, { role: user.role }));
              }
              await remember(roleMissing);
              /** Set after `remember` so this per-token value never enters the cached auth-user doc. */
              applyOpenIDSessionIdClaim(user, payload?.openidSessionId);
              done(null, user);
            },
            isTokenRetired,
          );
        } else {
          logger.warn('[jwtLogin] JwtStrategy => no user found: ' + payload?.id);
          done(null, false);
        }
      } catch (err) {
        done(err, false);
      }
    },
  );

module.exports = jwtLogin;
