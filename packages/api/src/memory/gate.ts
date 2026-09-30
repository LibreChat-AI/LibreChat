import { logger } from '@librechat/data-schemas';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { TClassificationConfig } from 'librechat-data-provider';
import type {
  Classifier,
  BooleanQuestion,
  ClassificationUsage,
  ClassificationQuestion,
} from '~/classification/types';
import { isBooleanAnswer, isChoiceAnswer } from '~/classification/types';
import { boolean, choice, isTrue } from '~/classification/questions';

export interface MemoryJudgment {
  process: boolean;
  hint?: string;
}

export interface MemoryGateInput {
  messages: BaseMessage[];
  /** Keys the memory model may write. Categorization is skipped without them. */
  validKeys?: string[];
}

export type MemoryGate = (input: MemoryGateInput) => Promise<MemoryJudgment>;

export type MemoryGateSettings = TClassificationConfig['memoryGate'];

export interface CreateMemoryGateParams {
  classifier: Classifier;
  settings: MemoryGateSettings;
  signal?: AbortSignal;
  windowSize?: number;
  maxChars?: number;
  /** Receives what each judgment cost, so the caller can bill it. */
  onUsage?: (usage: ClassificationUsage, model: string) => void;
}

const DEFAULT_WINDOW = 6;
const DEFAULT_MAX_CHARS = 8_000;
const PROCESS = { process: true } as const;

/** Matches the default memory instructions, which store only what the user asks to keep. */
export const MEMORY_REQUEST_QUESTION: BooleanQuestion = boolean(
  "Does `latest`, the user's newest message, ask the assistant to remember, update or forget " +
    'something about the user? `conversation` is the earlier context and is only there to help ' +
    'read `latest`.',
  {
    true:
      'An explicit request to remember, store, change or delete something, including a short ' +
      'yes to an offer to remember.',
    false:
      'Anything else, including preferences or facts the user mentions without asking for ' +
      'them to be kept.',
  },
);

export const CATEGORY_INSTRUCTIONS = 'Which stored memory does the request in `latest` concern?';

export const UPDATE_QUESTION: BooleanQuestion = boolean(
  'Does `latest` change something already known about this user, rather than adding ' +
    'something new?',
  {
    true: 'It corrects, replaces or narrows a fact the assistant would already hold.',
    false: 'It is new, or it repeats what is already stored without changing it.',
  },
);

function messageText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (part != null && typeof part === 'object' && 'text' in part) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') {
        parts.push(text);
      }
    }
  }
  return parts.join(' ');
}

export function transcribeTail(
  messages: BaseMessage[],
  windowSize: number,
  maxChars: number,
): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && lines.length < windowSize; i--) {
    const message = messages[i];
    const text = messageText(message).replace(/\s+/g, ' ').trim();
    if (text.length === 0) {
      continue;
    }
    const role = message._getType?.() ?? 'message';
    const line = `${role}: ${text}`;
    const clipped =
      line.length > maxChars - used ? line.slice(0, Math.max(0, maxChars - used)) : line;
    if (clipped.length === 0) {
      break;
    }
    lines.push(clipped);
    used += clipped.length;
    if (used >= maxChars) {
      break;
    }
  }
  return lines.reverse().join('\n');
}

/** Index of the newest user message, or -1 when the window holds none. */
function latestHumanIndex(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._getType?.() === 'human' && messageText(messages[i]).trim().length > 0) {
      return i;
    }
  }
  return -1;
}

export function buildHint(key: string | null, updates: boolean): string | undefined {
  if (key == null) {
    return undefined;
  }
  const change = updates
    ? ' It looks like a change to what is already stored there, not a new fact.'
    : '';
  return (
    '<memory_hint>\n' +
    `This request most likely belongs under \`${key}\`.${change}\n` +
    'Ignore this if it does not fit what the user actually said.\n' +
    '</memory_hint>'
  );
}

export function createMemoryGate(params: CreateMemoryGateParams): MemoryGate | null {
  const { classifier, settings, signal, onUsage } = params;
  if (settings?.enabled !== true) {
    return null;
  }
  const windowSize = params.windowSize ?? DEFAULT_WINDOW;
  const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
  const threshold = settings.threshold;
  const request = boolean(settings.instructions ?? MEMORY_REQUEST_QUESTION.instructions, {
    true: settings.whenTrue ?? MEMORY_REQUEST_QUESTION.criteria?.true,
    false: settings.whenFalse ?? MEMORY_REQUEST_QUESTION.criteria?.false,
  });

  function buildQuestions(validKeys: string[]): Record<string, ClassificationQuestion> {
    const questions: Record<string, ClassificationQuestion> = { request };
    if (settings.categorize === true && validKeys.length > 0) {
      questions.category = choice(
        CATEGORY_INSTRUCTIONS,
        Object.fromEntries(validKeys.map((key) => [key, null])),
      );
    }
    if (settings.detectUpdates === true) {
      questions.updates = UPDATE_QUESTION;
    }
    return questions;
  }

  return async function memoryGate({
    messages,
    validKeys = [],
  }: MemoryGateInput): Promise<MemoryJudgment> {
    const window = messages ?? [];
    const index = latestHumanIndex(window);
    if (index === -1) {
      return { process: false };
    }
    const latest = messageText(window[index]).replace(/\s+/g, ' ').trim().slice(0, maxChars);
    const transcript = transcribeTail(
      window.slice(0, index),
      windowSize - 1,
      Math.max(0, maxChars - latest.length),
    );
    try {
      const response = await classifier.classify({
        label: 'memory-gate',
        signal,
        timeoutMs: settings.timeoutMs,
        state: { latest, conversation: transcript },
        questions: buildQuestions(validKeys),
      });
      onUsage?.(response.usage, classifier.model);

      const answer = response.answers.request;
      if (!isBooleanAnswer(answer)) {
        return PROCESS;
      }
      if (!isTrue(answer, threshold)) {
        logger.debug(
          `[memoryGate] request ${answer.probability.toFixed(2)} below ${threshold}: skipping`,
        );
        return { process: false };
      }

      const categoryAnswer = response.answers.category;
      const key =
        isChoiceAnswer(categoryAnswer) &&
        (categoryAnswer.probabilities[categoryAnswer.choice] ?? 0) >= settings.categoryThreshold
          ? categoryAnswer.choice
          : null;
      const updatesAnswer = response.answers.updates;
      const updates = isBooleanAnswer(updatesAnswer) && updatesAnswer.probability >= 0.5;

      logger.debug(
        `[memoryGate] request ${answer.probability.toFixed(2)}: processing` +
          (key != null ? `, suggesting \`${key}\`${updates ? ' as an update' : ''}` : ''),
      );
      return { process: true, hint: buildHint(key, updates) };
    } catch (error) {
      logger.warn(
        '[memoryGate] judgment failed, processing memory as usual: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return PROCESS;
    }
  };
}
