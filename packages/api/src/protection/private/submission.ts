import type { FiltersConfig, MessageFilterPiiConfig } from 'librechat-data-provider';
import type { RequestHandler, Request, Response } from 'express';
import type { MessageMethods } from '@librechat/data-schemas';
import type { PrivateTextCipher } from './crypto';
import { ContentFilterError, isContentFilterError } from '../../middleware/contentFilter';
import { createPiiTextTransformer } from '../transform';
import { createPrivateTextCipher } from './crypto';
import { inspectContent } from '../runtime';

interface PrivateTextMessage {
  messageId?: string;
  conversationId?: string | null;
  isCreatedByUser?: boolean;
  text?: string;
  privacyRevision?: string;
  privateTextTokens?: readonly string[];
}

interface Capture {
  readonly userId: string;
  readonly tenantId: string;
  readonly revision: string;
  readonly text: string;
  readonly envelope: string;
  readonly cipher: PrivateTextCipher;
  readonly admission: Promise<boolean>;
  readonly admit: (allowed: boolean) => void;
  readonly admissionState: () => boolean | undefined;
}

const captures = new WeakMap<object, Capture>();

const CONTROL_ROUTES = new Set([
  'abort',
  'steer',
  'queued-turns',
  'stream',
  'status',
  'active',
  'resume',
]);

/** Every submitted text path can be denied before its route-specific filter runs. */
export function isPreDenialTextSubmission(req: Request): boolean {
  return req.method === 'POST' && typeof req.body?.text === 'string';
}

/** Only actual interactive chat POSTs have an owner-view text sidecar in this slice. */
export function isPrivateTextChatSubmission(req: Request): boolean {
  if (req.method !== 'POST' || typeof req.body?.text !== 'string') {
    return false;
  }
  const path = req.originalUrl?.split('?', 1)[0]?.replace(/\/$/, '');
  const base = '/api/agents/chat';
  if (path === base) {
    return true;
  }
  if (path == null || !path.startsWith(`${base}/`)) {
    return false;
  }
  const child = path.slice(base.length + 1);
  return child.length > 0 && !child.includes('/') && !CONTROL_ROUTES.has(child.toLowerCase());
}

function unavailable(): ContentFilterError {
  return new ContentFilterError({
    detectorId: 'pii-pattern',
    ruleId: 'private-text',
    label: 'private value that could not be protected',
    source: 'message',
    field: 'text',
    provenance: 'user',
    fragmentId: 'chat.text',
    fragmentPath: '/text',
  });
}

type PrivateTextRequest = Request & {
  config?: { filters?: FiltersConfig; messageFilter?: { pii?: MessageFilterPiiConfig } };
};

/** A denial may persist a turn before the regular message filter runs. Never store unfiltered PII. */
export function rejectUnprotectedDeniedMessage(req: PrivateTextRequest, res: Response): boolean {
  const filters = req.config?.filters;
  const legacyPii = req.config?.messageFilter?.pii;
  const text = req.body?.text;
  if (
    typeof text === 'string' &&
    req.config == null &&
    req.originalUrl?.split('?', 1)[0]?.startsWith('/api/agents/chat')
  ) {
    res.status(400).json({
      error: 'content_filter_block',
      message: 'Private details could not be protected. Nothing was sent to the model.',
    });
    return true;
  }
  if (
    typeof text !== 'string' ||
    (filters?.messages?.pii == null && legacyPii == null) ||
    captures.get(req)?.text === text
  ) {
    return false;
  }
  try {
    const finding = inspectContent(
      [
        {
          id: 'chat.text',
          path: '/text',
          text,
          source: 'message',
          field: 'text',
          format: 'plain',
          treatment: 'replaceable',
          provenance: 'user',
        },
      ],
      { filters, legacyPii },
    );
    if (finding == null) {
      return false;
    }
  } catch {
    // A broken policy must not turn a denial into unfiltered storage.
  }
  res.status(400).json({
    error: 'content_filter_block',
    message: 'Private details could not be protected. Nothing was sent to the model.',
  });
  return true;
}

export function privateTextBinding(
  userId: string,
  tenantId: string,
  message: PrivateTextMessage,
): string[] {
  return [
    userId,
    tenantId,
    message.conversationId ?? '',
    message.messageId ?? '',
    message.privacyRevision ?? '',
    message.text ?? '',
  ];
}

/** Installed only on the authenticated interactive Agent chat router, before any content consumer. */
export function createPrivateTextIngress(options: {
  getFilters(req: Request): FiltersConfig | undefined;
  getLegacyPii(req: Request): MessageFilterPiiConfig | undefined;
  getKey(): string;
}): RequestHandler {
  return (req, res, next) => {
    const rule = options.getFilters(req)?.messages?.pii;
    if (rule?.action !== 'redact' || typeof req.body?.text !== 'string') {
      next();
      return;
    }
    const body = req.body as {
      text: string;
      clientRequestId?: string;
      files?: object[];
      quotes?: string[];
      isEdited?: boolean;
      isContinued?: boolean;
      isRegenerate?: boolean;
      compact?: boolean;
      overrideParentMessageId?: string;
      overrideConvoId?: string;
      addedConvo?: boolean;
      editedContent?: unknown;
      recoverySteerId?: string;
      responseMessageId?: string;
    };
    const request = req as Request & {
      user?: { id?: string; tenantId?: string | null };
      _isAgentTrigger?: boolean;
    };
    if (
      req.path === '/resume' ||
      request._isAgentTrigger === true ||
      body.isEdited ||
      body.isContinued ||
      body.isRegenerate ||
      body.compact ||
      body.editedContent != null ||
      body.recoverySteerId != null ||
      (typeof body.clientRequestId === 'string' &&
        body.clientRequestId.startsWith('steer-recovery:')) ||
      body.overrideParentMessageId ||
      body.overrideConvoId ||
      body.addedConvo ||
      body.files?.length ||
      body.quotes?.length
    ) {
      next();
      return;
    }
    try {
      const fragment = {
        id: 'chat.text',
        path: '/text',
        text: body.text,
        source: 'message',
        field: 'text',
        format: 'plain',
        treatment: 'replaceable',
        provenance: 'user',
      } as const;
      const legacy = inspectContent([fragment], { legacyPii: options.getLegacyPii(req) });
      if (legacy != null) {
        throw new ContentFilterError(legacy);
      }
      const result = createPiiTextTransformer(rule).createSession().transform(fragment);
      if (result.replacements === 0) {
        next();
        return;
      }
      const userId = request.user?.id;
      const tenantId = request.user?.tenantId ?? '';
      if (
        !userId ||
        typeof body.clientRequestId !== 'string' ||
        body.clientRequestId.length > 256
      ) {
        throw unavailable();
      }
      const cipher = createPrivateTextCipher(options.getKey());
      const revision = cipher.revision([userId, tenantId, body.clientRequestId, body.text]);
      // A keyed, turn-specific namespace prevents unrelated historical placeholders aliasing.
      const text = result.content.replace(
        /\[(EMAIL|PHONE|NAME|CREDENTIAL|CUSTOM)_(\d+)\]/g,
        (marker, category: string, index: string) =>
          body.text.includes(marker) ? marker : `[${category}_${index}_${revision}]`,
      );
      const envelope = cipher.seal(body.text, [userId, tenantId, revision]);
      let resolveAdmission!: (allowed: boolean) => void;
      let admissionResult: boolean | undefined;
      const admission = new Promise<boolean>((resolve) => {
        resolveAdmission = resolve;
      });
      const admit = (allowed: boolean) => {
        if (admissionResult === undefined) {
          admissionResult = allowed;
          resolveAdmission(allowed);
        }
      };
      captures.set(req, {
        userId,
        tenantId,
        revision,
        text,
        envelope,
        cipher,
        admission,
        admit,
        admissionState: () => admissionResult,
      });
      body.text = text;
      next();
    } catch {
      res.status(400).json({
        error: 'content_filter_block',
        message: 'Private details could not be protected. Nothing was sent to the model.',
      });
    }
  };
}

/** Only a user turn that will persist its sidecar advertises an owner-readable revision. */
export function stampPrivateTextMessage<T extends PrivateTextMessage>(
  req: object | undefined,
  message: T,
  willPersist = true,
): T & { privacyRevision?: string } {
  const capture = req == null ? undefined : captures.get(req);
  if (
    willPersist &&
    capture != null &&
    message.isCreatedByUser === true &&
    message.text === capture.text
  ) {
    message.privacyRevision = capture.revision;
  }
  return message;
}

/** Only the request that ran ingress may skip its exact, already-inspected submitted text. */
export function getPreinspectedPrivateText(req: Request): string | undefined {
  const capture = captures.get(req);
  return capture != null && req.body?.text === capture.text ? capture.text : undefined;
}

/** Only call with server-owned canonical rows; generic writes strip their private revision. */
export function getPrivateTextInspectionTokens(
  messages: readonly (PrivateTextMessage | null | undefined)[],
): ReadonlySet<string> {
  const tokens = new Set<string>();
  // Mirror the existing provider work and maximum transformed-text ceilings.
  if (messages.length > 4096) {
    return tokens;
  }
  for (const message of messages) {
    if (message?.isCreatedByUser !== true || typeof message.text !== 'string') {
      continue;
    }
    if (message.text.length > 524288) {
      return new Set();
    }
    if ((message.privateTextTokens?.length ?? 0) > 4096) {
      return new Set();
    }
    for (const token of message.privateTextTokens ?? []) {
      if (
        /^\[(?:EMAIL|PHONE|NAME|CREDENTIAL|CUSTOM)_\d+_[a-f0-9]{32}\]$/.test(token) &&
        message.text.includes(token)
      ) {
        tokens.add(token);
        if (tokens.size > 4096) {
          return new Set();
        }
      }
    }
    for (const match of message.text.matchAll(
      /\[(?:EMAIL|PHONE|NAME|CREDENTIAL|CUSTOM)_\d+_([a-f0-9]{32})\]/g,
    )) {
      if (match[1] === message.privacyRevision) {
        tokens.add(match[0]);
        if (tokens.size > 4096) {
          return new Set();
        }
      }
    }
  }
  return tokens;
}

/** The preliminary job record precedes the created event and may be read by Stop. */
export function stampPreliminaryPrivateTextMessage<T extends PrivateTextMessage>(
  req: object | undefined,
  message: T | null,
): (T & { privacyRevision?: string }) | null {
  if (message == null) {
    return null;
  }
  const capture = req == null ? undefined : captures.get(req);
  if (capture != null && capture.text === message.text) {
    return { ...message, privacyRevision: capture.revision };
  }
  return message;
}

/** Encrypts against final server-resolved message identity, then commits both views in one write. */
export async function savePrivateTextMessage(
  save: MessageMethods['saveMessage'],
  req: object | undefined,
  ...args: Parameters<MessageMethods['saveMessage']>
): ReturnType<MessageMethods['saveMessage']> {
  const [ctx, message, metadata] = args;
  const capture = req == null ? undefined : captures.get(req);
  if (capture == null || message.isCreatedByUser !== true) {
    return save(...args);
  }
  if (capture.admissionState() === false || message.text !== capture.text) {
    throw unavailable();
  }
  if (
    ctx.userId !== capture.userId ||
    !message.messageId ||
    !message.conversationId ||
    message.newMessageId
  ) {
    throw unavailable();
  }
  const revision = capture.revision;
  const original = capture.cipher.open(capture.envelope, [
    capture.userId,
    capture.tenantId,
    revision,
  ]);
  const envelope = capture.cipher.seal(
    original,
    privateTextBinding(capture.userId, capture.tenantId, { ...message, privacyRevision: revision }),
  );
  const saved = await save(
    ctx,
    { ...message, tenantId: capture.tenantId || undefined },
    {
      ...metadata,
      privateText: { envelope, revision },
    },
  );
  if (
    saved?.privacyRevision !== revision ||
    saved.text !== capture.text ||
    saved.messageId !== message.messageId ||
    saved.conversationId !== message.conversationId
  ) {
    throw unavailable();
  }
  return saved;
}

/** Must complete before sendCompletion. Existing cancellation/deletion still owns the run. */
export async function requirePrivateTextPersistence(
  req: object | undefined,
  start: () => Promise<{ message?: PrivateTextMessage | null } | undefined>,
  onPersisted?: () => void,
): Promise<void> {
  const capture = req == null ? undefined : captures.get(req);
  if (capture == null) {
    return;
  }
  try {
    if (capture.admissionState() === false) {
      throw unavailable();
    }
    const result = await start();
    if (
      capture.admissionState() === false ||
      result?.message?.privacyRevision !== capture.revision ||
      result.message.text !== capture.text
    ) {
      throw unavailable();
    }
    capture.admit(true);
    onPersisted?.();
  } catch (error) {
    capture.admit(false);
    throw error;
  }
}

/** Optional model side effects share the turn's admission decision, without starting its write. */
export async function requirePrivateTextAdmission(
  req: object | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const capture = req == null ? undefined : captures.get(req);
  if (capture == null) {
    return;
  }
  if (signal?.aborted) {
    throw unavailable();
  }
  let abort!: () => void;
  const cancelled = new Promise<boolean>((resolve) => {
    abort = () => resolve(false);
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    if (!(await Promise.race([capture.admission, cancelled])) || signal?.aborted) {
      throw unavailable();
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export function rejectPrivateTextAdmission(req: object | undefined): void {
  if (req != null) {
    captures.get(req)?.admit(false);
  }
}

/** Stop before protected admission owns no persisted turn. Ordinary Stop retains its writer. */
export function bindPrivateTextPersistenceAbort(
  req: object | undefined,
  signal: AbortSignal | undefined,
  start: () => unknown,
  cancel: () => unknown,
): () => void {
  const abort = () => {
    const capture = req == null ? undefined : captures.get(req);
    if (capture != null && capture.admissionState() !== true) {
      capture.admit(false);
      cancel();
      return;
    }
    start();
  };
  if (signal?.aborted) {
    abort();
    return () => {};
  }
  signal?.addEventListener('abort', abort, { once: true });
  return () => signal?.removeEventListener('abort', abort);
}

/** Recovery may retain ordinary failures, but cannot revive an unadmitted protected turn. */
export async function savePrivateTextErrorTurn(
  req: object | undefined,
  error: unknown,
  save: () => Promise<void>,
): Promise<void> {
  const capture = req == null ? undefined : captures.get(req);
  if (capture != null) {
    if (capture.admissionState() !== true && isContentFilterError(error)) {
      capture.admit(false);
    }
    if (capture.admissionState() === false) {
      return;
    }
  }
  await save();
}

/** Ordinary startup stays immediate; protected revisions are announced only after admission. */
export function deferPrivateTextStart(
  req: object | undefined,
  onStart: ((message: PrivateTextMessage, responseId: string, isNew: boolean) => void) | undefined,
  message: PrivateTextMessage,
  responseId: string,
  isNew: boolean,
): (() => void) | undefined {
  if (typeof onStart !== 'function') {
    return;
  }
  if (req == null || !captures.has(req)) {
    onStart(message, responseId, isNew);
    return;
  }
  let announced = false;
  return () => {
    if (!announced) {
      announced = true;
      onStart(message, responseId, isNew);
    }
  };
}

/** Runs only after the exact native payload passes its policy callback. */
export function getPrivateTextAdmission(
  req: object | undefined,
  start: (() => Promise<{ message?: PrivateTextMessage | null } | undefined>) | undefined,
  onPersisted?: () => void,
): (() => Promise<void>) | undefined {
  if (req == null || !captures.has(req)) {
    return;
  }
  if (start == null) {
    throw unavailable();
  }
  return () => requirePrivateTextPersistence(req, start, onPersisted);
}

/**
 * Stop has a different request and cannot retrieve the original plaintext. Verify
 * protected rows instead of rewriting their canonical text. Older job records may
 * omit the revision, so their prerequisite is an insert-only write.
 */
export async function saveAbortedUserMessage(
  store: Pick<MessageMethods, 'saveMessage' | 'getPersistedPrivateTextId'>,
  ctx: Parameters<MessageMethods['saveMessage']>[0],
  message: Parameters<MessageMethods['saveMessage']>[1],
  metadata: Parameters<MessageMethods['saveMessage']>[2],
  tenantId?: string,
  finalEvent?: { requestMessage?: { privacyRevision?: string } | null },
): Promise<{ _id?: unknown }> {
  const revision = message.privacyRevision;
  if (typeof revision !== 'string' || revision.length === 0) {
    if (!message.messageId || !message.conversationId) {
      throw unavailable();
    }
    const saved = await store.saveMessage(ctx, message, { ...metadata, insertOnly: true });
    if (
      saved == null ||
      saved.messageId !== message.messageId ||
      saved.conversationId !== message.conversationId ||
      saved.text !== message.text
    ) {
      throw unavailable();
    }
    if (typeof saved.privacyRevision === 'string' && saved.privacyRevision.length > 0) {
      if (typeof saved.text !== 'string') {
        throw unavailable();
      }
      const exists = await store.getPersistedPrivateTextId({
        userId: ctx.userId,
        tenantId,
        conversationId: message.conversationId,
        messageId: message.messageId,
        text: saved.text,
        privacyRevision: saved.privacyRevision,
      });
      if (!exists) {
        throw unavailable();
      }
      if (finalEvent?.requestMessage != null) {
        finalEvent.requestMessage.privacyRevision = saved.privacyRevision;
      }
    }
    return { _id: saved._id };
  }
  if (!message.messageId || !message.conversationId || typeof message.text !== 'string') {
    throw unavailable();
  }
  const persisted = await store.getPersistedPrivateTextId({
    userId: ctx.userId,
    tenantId,
    conversationId: message.conversationId,
    messageId: message.messageId,
    text: message.text,
    privacyRevision: revision,
  });
  if (!persisted) {
    throw unavailable();
  }
  return { _id: persisted };
}
