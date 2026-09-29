import type { MessageMethods } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import { resolveLangfuseTenantDestination } from './tenantDestinations';
import { getLangfuseDestinationId } from './destinations';
import { isLangfuseConnectionAvailable } from './policy';

export interface LangfuseSessionLinkParams {
  config: TCustomConfig['langfuse'];
  conversationId: string;
  userId: string;
  getMessages: MessageMethods['getMessages'];
}

export interface LangfuseSession {
  url: string;
  /** Identity of the project `url` opens (see `getLangfuseDestinationId`). */
  destinationId: string;
}

export async function resolveLangfuseSession({
  config,
  conversationId,
  userId,
  getMessages,
}: LangfuseSessionLinkParams): Promise<LangfuseSession | null> {
  if (!isLangfuseConnectionAvailable()) {
    return null;
  }

  const destination = resolveLangfuseTenantDestination(config?.destination);
  const projectId = config?.projectId?.trim();
  if (config?.enabled !== true || !destination || !projectId) {
    return null;
  }

  const destinationId = getLangfuseDestinationId(destination.baseUrl, projectId);
  const messages = await getMessages(
    {
      user: userId,
      conversationId,
      langfuseSampled: true,
      langfuseDestinationIds: destinationId,
    },
    '_id',
    { sort: false, limit: 1 },
  );
  if (messages.length === 0) {
    return null;
  }

  const sessionUrl = new URL(destination.baseUrl);
  const basePath = sessionUrl.pathname.replace(/\/+$/, '');
  sessionUrl.pathname = `${basePath}/project/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(conversationId)}`;
  return { url: sessionUrl.toString(), destinationId };
}

export async function resolveLangfuseSessionUrl(
  params: LangfuseSessionLinkParams,
): Promise<string | null> {
  return (await resolveLangfuseSession(params))?.url ?? null;
}
