import { logger } from '@librechat/data-schemas';
import {
  EModelEndpoint,
  isAgentsEndpoint,
  extractEnvVariable,
  normalizeEndpointName,
} from 'librechat-data-provider';
import type { TConversation, TEndpointOption } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { NextFunction, Response } from 'express';
import type { OpenIDSessionRefreshService } from '~/auth/openid/session';
import type { ServerRequest } from '~/types/http';
import {
  extractOpenIDTokenInfo,
  isOpenIDTokenValid,
  OpenIDReauthRequiredError,
} from '~/utils/oidc';
import { getBuiltInBaseURL } from '~/endpoints/openai/initialize';
import { getSafeErrorMetadata } from '~/utils/errors';
import { needsOpenIDAccessToken } from '~/utils/env';
import { isUserProvided } from '~/utils/common';
import { mergeHeaders } from '~/utils/headers';

type Endpoints = NonNullable<AppConfig['endpoints']>;

/** A model the turn will call, and the endpoint that serves it. */
type Target = { endpoint: string; model?: string };

/** `buildEndpointOption` also carries the added conversation of a multi-response turn. */
type TurnOption = Partial<TEndpointOption> & {
  addedConvo?: Pick<TConversation, 'endpoint' | 'model'> | null;
};

const REAUTH_MESSAGE =
  'The OpenID session could not provide a current access token for the model request. Please sign in again.';

/**
 * The header templates a request to the target resolves, merged as its endpoint initializer merges
 * them: an endpoint's own headers override the shared `endpoints.all` ones, Bedrock sends none,
 * custom endpoints send only their own, and none of these reach a user-provided base URL except an
 * Azure group's.
 */
function getTargetHeaders(
  endpoints: Endpoints,
  { endpoint, model }: Target,
): Record<string, string> | undefined {
  const trusted = !isUserProvided(getBuiltInBaseURL(endpoint));
  const shared = trusted ? endpoints.all?.headers : undefined;
  switch (endpoint) {
    case EModelEndpoint.openAI:
      return trusted ? mergeHeaders(shared, endpoints.openAI?.headers) : undefined;
    case EModelEndpoint.anthropic:
    case EModelEndpoint.google:
      return mergeHeaders(shared, endpoints[endpoint]?.headers);
    case EModelEndpoint.azureOpenAI: {
      const azure = endpoints.azureOpenAI;
      const group = model ? azure?.modelGroupMap?.[model]?.group : undefined;
      return mergeHeaders(shared, group ? azure?.groupMap?.[group]?.additionalHeaders : undefined);
    }
    case EModelEndpoint.bedrock:
      return undefined;
    default: {
      const name = normalizeEndpointName(endpoint);
      const config = endpoints.custom?.find(
        (custom) => normalizeEndpointName(custom.name) === name,
      );
      return isUserProvided(extractEnvVariable(config?.baseURL ?? ''))
        ? undefined
        : config?.headers;
    }
  }
}

/** Whether any model endpoint forwards the user's OpenID access token, before the turn is read. */
function anyForwardsOpenIDAccessToken(endpoints: Endpoints): boolean {
  return [
    endpoints.all?.headers,
    endpoints.openAI?.headers,
    endpoints.anthropic?.headers,
    endpoints.google?.headers,
    ...Object.values(endpoints.azureOpenAI?.groupMap ?? {}).map(
      (group) => group?.additionalHeaders,
    ),
    ...(endpoints.custom ?? []).map((config) => config.headers),
  ].some((headers) => needsOpenIDAccessToken(headers));
}

/**
 * The models the user picked for this turn: the agent's, and an added conversation's when it names
 * an endpoint directly rather than another agent. The agent is the promise `buildEndpointOption`
 * started, so reading it costs no extra query.
 */
async function getTurnTargets(req: ServerRequest): Promise<Target[]> {
  const option = req.body?.endpointOption as TurnOption | undefined;
  const agent = await option?.agent;
  const added = option?.addedConvo;
  const targets: Target[] = [];
  if (agent?.provider) {
    targets.push({ endpoint: agent.provider, model: agent.model ?? undefined });
  }
  if (added?.endpoint && !isAgentsEndpoint(added.endpoint)) {
    targets.push({ endpoint: added.endpoint, model: added.model ?? undefined });
  }
  return targets;
}

/**
 * Makes the user's OpenID access token current before an agent turn is accepted, when an endpoint
 * the turn uses forwards it in a header. `req.user.federatedTokens` holds what the OpenID strategy
 * read from the session at authentication, and the header resolver refuses an expired or missing
 * access token only once the turn is running. The session reuses its live token or refreshes it
 * through the IdP, as for MCP bearer headers; when it cannot, the request ends with a 401 before
 * the turn starts, so the client refreshes its session and retries. Only requests the OpenID
 * token-reuse strategy authenticated are considered: trigger and queued-turn requests carry no
 * browser session.
 */
export function createOpenIDTokenRefresh({
  createOpenIDSessionTokenProvider,
}: Pick<OpenIDSessionRefreshService, 'createOpenIDSessionTokenProvider'>) {
  return async function refreshOpenIDToken(
    req: ServerRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const user = req.user;
    const endpoints = req.config?.endpoints;
    if (user == null || endpoints == null || req.authStrategy !== 'openidJwt') {
      return next();
    }
    if (!anyForwardsOpenIDAccessToken(endpoints)) {
      return next();
    }
    const tokenInfo = extractOpenIDTokenInfo(user);
    if (tokenInfo == null || isOpenIDTokenValid(tokenInfo)) {
      return next();
    }
    const targets = await getTurnTargets(req);
    if (!targets.some((target) => needsOpenIDAccessToken(getTargetHeaders(endpoints, target)))) {
      return next();
    }

    let tokens;
    try {
      tokens = await createOpenIDSessionTokenProvider({
        req,
        res,
        user,
        tokenPreference: 'access_token',
      })();
    } catch (error) {
      logger.warn(
        '[refreshOpenIDToken] OpenID session refresh failed before the model request',
        getSafeErrorMetadata(error),
      );
      const reauthError = new OpenIDReauthRequiredError(REAUTH_MESSAGE);
      reauthError.cause = error;
      return next(reauthError);
    }

    if (tokens?.access_token) {
      user.federatedTokens = {
        access_token: tokens.access_token,
        id_token: tokens.id_token ?? user.federatedTokens?.id_token,
        refresh_token: tokens.refresh_token ?? user.federatedTokens?.refresh_token,
        expires_at: tokens.expires_at,
      };
    }
    if (!isOpenIDTokenValid(extractOpenIDTokenInfo(user))) {
      return next(new OpenIDReauthRequiredError(REAUTH_MESSAGE));
    }
    next();
  };
}
