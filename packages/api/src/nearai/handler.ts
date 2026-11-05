import { logger } from '@librechat/data-schemas';
import {
  EModelEndpoint,
  hasVerifiedReports,
  DEFAULT_NEAR_AI_REPORT_CACHE_TTL_MS,
} from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest, GetUserKeyValuesFunction } from '~/types';
import type { NearAIService } from './types';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getNearAICredentials } from './credentials';
import { isNearAIEndpoint } from './attestation';
import { reportCheckedAt } from './report';

export function getNearAIVerificationConfig(
  appConfig?: AppConfig,
): Required<Pick<TStartupConfig, 'nearaiVerifyUrl' | 'nearaiEndpoints'>> {
  const custom = appConfig?.endpoints?.[EModelEndpoint.custom];
  return {
    nearaiVerifyUrl: appConfig?.config?.nearai?.verifyUrl ?? 'https://cloud.near.ai/verify',
    nearaiEndpoints: (Array.isArray(custom) ? custom : []).flatMap((endpoint) =>
      endpoint.name && isNearAIEndpoint(endpoint) ? [endpoint.name] : [],
    ),
  };
}

/** Display verification is separate from the SDK's mandatory chat preflight. */
export function createNearAIHandlers(
  service: NearAIService,
  getUserKeyValues: GetUserKeyValuesFunction,
): (
  req: Pick<ServerRequest, 'query' | 'config'> & {
    user?: { id: string; tenantId?: string | null };
  },
  res: Response,
) => Promise<Response> {
  return async (
    req: Pick<ServerRequest, 'query' | 'config'> & {
      user?: { id: string; tenantId?: string | null };
    },
    res: Response,
  ): Promise<Response> => {
    res.set('Cache-Control', 'no-store');
    const { endpoint, model, refresh, reports, scope, force } = req.query;
    if (
      typeof endpoint !== 'string' ||
      !endpoint ||
      typeof model !== 'string' ||
      !model ||
      model.length > 512
    ) {
      return res.status(400).json({ error: { code: 'nearai_invalid_request' } });
    }
    try {
      const credentials = await getNearAICredentials(req.config, endpoint, {
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
        getUserKeyValues,
      });
      if (!credentials) return res.json({ enabled: false });
      if (reports !== '1')
        return res.json({
          enabled: true,
          ...(await service.verify(credentials, model, refresh === '1')),
        });
      const result = await service.reports(credentials, model, {
        scope: scope === 'gateway' ? 'gateway' : undefined,
        refresh: refresh === '1',
        ...(force === '1' && { force: true }),
      });
      const checkedAt = reportCheckedAt(result);
      let status = 'failed';
      if (hasVerifiedReports(result))
        status = result.some((item) => item.scope === 'model') ? 'verified' : 'partial';
      return res.json({
        enabled: true,
        model,
        reports: result,
        status,
        checkedAt,
        expiresAt: new Date(
          Date.parse(checkedAt) +
            (credentials.reportCacheTtlMs ?? DEFAULT_NEAR_AI_REPORT_CACHE_TTL_MS),
        ).toISOString(),
      });
    } catch (error) {
      logger.warn('[nearai] Verification request unavailable', getSafeErrorMetadata(error));
      return res.status(503).json({ error: { code: 'nearai_verification_unavailable' } });
    }
  };
}
