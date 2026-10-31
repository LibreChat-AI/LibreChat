/** Stored assistant-message projection shared by channel trace and feedback consumers. */
export interface ChannelMessage {
  messageId: string;
  conversationId: string;
  user: string;
  tenantId?: string;
  isCreatedByUser?: boolean;
  isUserSubmitted?: boolean;
  isTemporary?: boolean;
  expiredAt?: Date | string | null;
  langfuseRunId?: string | null;
  langfuseCentralTraceExportEnabled?: boolean | null;
  langfuseSampled?: boolean | null;
  langfuseDestinationIds?: string[] | null;
}
import type { AgentChannelRecord } from '@librechat/data-schemas';
import type { ChannelConfig } from 'librechat-data-provider';
import type { Request, Response, RequestHandler } from 'express';

export type ChannelServiceGuard = (
  handler: (
    req: Request,
    res: Response,
    channel: AgentChannelRecord,
    config: ChannelConfig,
  ) => Promise<void>,
) => RequestHandler;
