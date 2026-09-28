import type {
  CodeApprovalMode,
  CodeEnvironmentMode,
  CodeWorkspaceSelection,
  TEndpointOption,
  Agents,
} from 'librechat-data-provider';
import type { IUser, AppConfig, IConversation } from '@librechat/data-schemas';
import type { Request } from 'express';

/**
 * LibreChat-specific request body type that extends Express Request body
 * (have to use type alias because you can't extend indexed access types like Request['body'])
 */
export type RequestBody = {
  messageId?: string;
  fileTokenLimit?: number;
  conversationId?: string;
  parentMessageId?: string;
  endpoint?: string;
  endpointType?: string;
  model?: string;
  imageDetail?: Agents.ImageDetail;
  key?: string;
  endpointOption?: Partial<TEndpointOption>;
  /** Browser IANA timezone used to resolve local-time prompt variables (e.g. `{{current_datetime}}`). */
  timezone?: string;
  codeApprovalMode?: CodeApprovalMode;
  codeEnvironmentMode?: CodeEnvironmentMode;
  codeWorkspaces?: CodeWorkspaceSelection[];
};

export type ServerRequest = Request<unknown, unknown, RequestBody> & {
  user?: IUser;
  config?: AppConfig;
  /** Server-captured generation start time used to anchor dynamic prompt variables. */
  turnStartedAt?: number;
  /** Server-captured conversation creation time used when inserting conversation metadata. */
  conversationCreatedAt?: string;
  /** Conversation read by request middleware (`null` = looked up, absent), reused by the
   *  subagent guard, agent initialization, and the first save instead of re-reading it. */
  resolvedConversation?: Partial<IConversation> | null;
  /** Passport strategy that populated req.user for this request. */
  authStrategy?: string;
};
