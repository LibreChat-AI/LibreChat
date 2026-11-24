import {
  Constants,
  ErrorTypes,
  messageFileIds,
  findMessageById,
  messageCarriesFiles,
  parseLangChainErrorCode,
} from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { isSubmittableMessage } from '../turns/draft';
import { extractJson, isJson } from '../json';

let patterns: RegExp[] | undefined;

/**
 * Failures that come from what a conversation carries rather than from the model or the network:
 * a file the code environment refused or rate-limited, a file that could not be restored or is
 * gone, a turn over the attachment limits, documents the provider rejected, and a request too long
 * for the context window, which a conversation full of screenshots or documents reaches. Every
 * later turn resends the same files, so each of these recurs until the files leave the branch.
 * Built on first use: a module must not read `librechat-data-provider` while it loads.
 */
function attachmentErrorPatterns(): RegExp[] {
  patterns ??= [
    /code environment file/i,
    new RegExp(ErrorTypes.RESOURCE_RECOVERY_REQUIRED, 'i'),
    new RegExp(`"(${ErrorTypes.INPUT_LENGTH}|${ErrorTypes.FINAL_CONTEXT_OVERFLOW})"`, 'i'),
    /prompt is too long|input is too long|context_length_exceeded|maximum context length/i,
    /request_too_large|request entity too large|payload too large/i,
    /\battach(ed|ments?)\b/i,
    /duplicate document names?/i,
    /\b(image|document|pdf|file)s?\b[^.\n]{0,60}\b(too large|too big|exceeds?|too many|could not be (processed|read)|unsupported|not supported)\b/i,
  ];
  return patterns;
}

/** Whether a failed turn's text reads as a failure caused by the conversation's files. */
export function isAttachmentError(text: string): boolean {
  return attachmentErrorPatterns().some((pattern) => pattern.test(text));
}

/**
 * Whether the turn was refused for carrying too many files of its own. Only the files new to a
 * turn count toward that limit, so the conversation's earlier files are not the cause and
 * leaving them out changes nothing.
 */
export function isCountLimitError(text: string): boolean {
  return /attachment count limit/i.test(text);
}

let fileAgnosticCodes: Set<string> | undefined;

/**
 * Typed failures whose cause the payload already states, where files may still be to blame: the
 * provider refused or could not complete the request without saying it was the files.
 */
function fileAgnosticErrorCodes(): Set<string> {
  fileAgnosticCodes ??= new Set<string>([
    /** Anthropic's own error bodies are typed just `error`. */
    'error',
    ErrorTypes.UPSTREAM_MODEL_ERROR,
    ErrorTypes.INVALID_REQUEST,
    ErrorTypes.GOOGLE_ERROR,
    ErrorTypes.EMPTY_MESSAGES,
  ]);
  return fileAgnosticCodes;
}

/** LangChain codes with a remedy of their own: the model, its key, or its rate limit. */
const remedialLangChainCodes = new Set([
  'MODEL_NOT_FOUND',
  'MODEL_RATE_LIMIT',
  'MODEL_AUTHENTICATION',
]);

/** The code a typed payload names, top level first, then an OpenAI-style `error` envelope. */
function readErrorCode(text: string): string | undefined {
  const json = extractJson(text);
  if (json === '' || !isJson(json)) {
    return undefined;
  }
  const payload = JSON.parse(json) as {
    code?: unknown;
    type?: unknown;
    error?: { code?: unknown; type?: unknown } | null;
  };
  const outer = [payload.code, payload.type];
  const nested = [payload.error?.code, payload.error?.type];
  /** A generic `error` type is only the envelope; what failed is named inside it. */
  const candidates = payload.type === 'error' ? [...nested, ...outer] : [...outer, ...nested];
  return candidates.find((value): value is string => typeof value === 'string' && value !== '');
}

/**
 * Whether dropping files is a plausible way out of this failure. Anything that reads as a file
 * problem is; so is a provider failure that says nothing about its cause. A failure with its own
 * remedy (a missing key, a balance, a rate or message limit, a moderation block) is not, and
 * offering files as the fix there would point the reader the wrong way.
 */
export function mayBeAttachmentError(text: string): boolean {
  if (isAttachmentError(text)) {
    return true;
  }
  /** Rows persisted before LangChain failures were typed carry the code in the message text. */
  const langChainCode = parseLangChainErrorCode(text);
  if (langChainCode != null && remedialLangChainCodes.has(langChainCode)) {
    return false;
  }
  const code = readErrorCode(text);
  return code == null || fileAgnosticErrorCodes().has(code);
}

export type AttachmentRecovery = {
  /** The user turn the failed response answered, which a retry sends again. */
  parent: TMessage;
  /** The turn's own text can be sent again without the files it carried. */
  canRetry: boolean;
  /**
   * Earlier turns carry files too, which a retry would still resend, so the branch can only be
   * cleared by copying it without any. Names the message the copy ends at: the response before
   * the failed turn, so the copy has no failure in it and the failed message can be sent again.
   */
  branchTargetId?: string;
  /** Earlier turns carry files the failed turn does not, which the conversation can leave out. */
  olderCarryFiles: boolean;
};

/**
 * Which ways out a failed response offers when its branch carries files. Walks only the failed
 * turn's ancestors, through the messages array's memoized id index, so the cost is the branch
 * depth rather than the conversation size.
 */
export function findAttachmentRecovery(
  messages: TMessage[] | null | undefined,
  failed: Pick<TMessage, 'parentMessageId' | 'isCreatedByUser'>,
): AttachmentRecovery | null {
  if (failed.isCreatedByUser === true) {
    return null;
  }
  const parent = findMessageById(messages, failed.parentMessageId);
  if (parent == null || parent.isCreatedByUser !== true) {
    return null;
  }

  const visited = new Set<string>([parent.messageId]);
  let own: Set<string> | undefined;
  let earlierCarriesFiles = false;
  let olderCarryFiles = false;
  let currentId = parent.parentMessageId;
  while (currentId != null && currentId !== Constants.NO_PARENT && !visited.has(currentId)) {
    visited.add(currentId);
    const ancestor = findMessageById(messages, currentId);
    if (ancestor == null) {
      break;
    }
    if (messageCarriesFiles(ancestor)) {
      earlierCarriesFiles = true;
      /** A file the failed turn carries too would still be sent, so it is not one to leave out. */
      own ??= new Set(messageFileIds(parent));
      const kept = own;
      if (messageFileIds(ancestor).some((fileId) => !kept.has(fileId))) {
        olderCarryFiles = true;
        break;
      }
    }
    currentId = ancestor.parentMessageId;
  }

  const canRetry = messageCarriesFiles(parent) && isSubmittableMessage(parent.text, 0);
  const previousId = parent.parentMessageId;
  const branchTargetId =
    earlierCarriesFiles && previousId != null && previousId !== Constants.NO_PARENT
      ? previousId
      : undefined;

  if (!canRetry && branchTargetId == null) {
    return null;
  }
  return { parent, canRetry, branchTargetId, olderCarryFiles };
}

/**
 * The files of the turns before `parent` on its branch, oldest turn last, without any the turn
 * carries itself: those it would still send. Walked on the click that needs them, not while the
 * card renders.
 */
export function collectOlderFileIds(
  messages: TMessage[] | null | undefined,
  parent: Pick<TMessage, 'messageId' | 'parentMessageId' | 'files' | 'attachments' | 'content'>,
): string[] {
  const own = new Set(messageFileIds(parent));
  const older = new Set<string>();
  const visited = new Set<string>([parent.messageId]);
  let currentId = parent.parentMessageId;
  while (currentId != null && currentId !== Constants.NO_PARENT && !visited.has(currentId)) {
    visited.add(currentId);
    const ancestor = findMessageById(messages, currentId);
    if (ancestor == null) {
      break;
    }
    for (const fileId of messageFileIds(ancestor)) {
      if (!own.has(fileId)) {
        older.add(fileId);
      }
    }
    currentId = ancestor.parentMessageId;
  }
  return [...older];
}
