/**
 * TspiChat's click routes to the TSPI Brain (M04): Confirm / Cancel on a pending change, and Open
 * on a patient. The browser intercepts these panel buttons (`client/src/utils/tspi.ts`) and posts
 * them here instead of to the model; the route checks the user owns the conversation and calls
 * the Brain with an aud=tspi-api token carrying that conversation (`cnv`).
 */
import type { TspiTokenUser } from '../auth/tspiMcpToken';
import type { TspiBrainClient, TspiChatContext, TspiConfirmation } from './brainClient';
import { TspiBrainError, createTspiBrainClient } from './brainClient';

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface TspiActionDeps {
  /** True when this user owns the conversation (the same check as `validateConvoAccess`). */
  ownsConversation: (userId: string, conversationId: string) => Promise<boolean>;
  /** Injected for tests; defaults to the REST client for this user and conversation. */
  brain?: (user: TspiTokenUser, conversationId: string) => TspiBrainClient;
}

export interface TspiConfirmationInput {
  conversationId?: unknown;
  confirmationId?: unknown;
  decision?: unknown;
  payloadSha256?: unknown;
}

export interface TspiOpenPatientInput {
  conversationId?: unknown;
  patientId?: unknown;
}

const userIdOf = (user: TspiTokenUser): string => String(user.id ?? user._id ?? '');

async function brainFor(
  user: TspiTokenUser,
  conversationId: unknown,
  deps: TspiActionDeps,
): Promise<TspiBrainClient> {
  if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) {
    throw new TspiBrainError('invalid', 400, 'A conversation is required');
  }
  if (!(await deps.ownsConversation(userIdOf(user), conversationId))) {
    throw new TspiBrainError('forbidden', 403, 'Not your conversation');
  }
  const make = deps.brain ?? ((u, cnv) => createTspiBrainClient(u, { conversationId: cnv }));
  return make(user, conversationId);
}

export async function decideTspiConfirmation(
  user: TspiTokenUser,
  input: TspiConfirmationInput,
  deps: TspiActionDeps,
): Promise<TspiConfirmation> {
  const { confirmationId, decision, payloadSha256 } = input;
  if (
    typeof confirmationId !== 'string' ||
    typeof payloadSha256 !== 'string' ||
    (decision !== 'confirm' && decision !== 'cancel')
  ) {
    throw new TspiBrainError('invalid', 400, 'Invalid confirmation');
  }
  const brain = await brainFor(user, input.conversationId, deps);
  return brain.decideConfirmation(confirmationId, decision, payloadSha256);
}

export async function openTspiPatient(
  user: TspiTokenUser,
  input: TspiOpenPatientInput,
  deps: TspiActionDeps,
): Promise<TspiChatContext> {
  if (typeof input.patientId !== 'string') {
    throw new TspiBrainError('invalid', 400, 'Invalid patient');
  }
  const brain = await brainFor(user, input.conversationId, deps);
  return brain.openPatient(input.patientId);
}

/** HTTP status and a body safe for the browser: the Brain's problem code, never internals. */
export function tspiActionError(error: unknown): { status: number; body: { error: string } } {
  if (error instanceof TspiBrainError) {
    const status = error.code === 'not_configured' ? 503 : error.status;
    return { status: status >= 500 ? 502 : status, body: { error: error.problem ?? error.code } };
  }
  return { status: 502, body: { error: 'unavailable' } };
}
