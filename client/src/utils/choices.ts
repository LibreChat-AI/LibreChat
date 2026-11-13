import { v4 } from 'uuid';
import { resolveComposerConversationId } from './drafts';

export const FILE_SEARCH_CHOICE_PREFIX = 'file-search-choice:';
type FileSearchChoice = { revision: string | null; enabled: boolean };
const unavailableStorage = new Map<string, FileSearchChoice>();

function readFileSearchChoice(conversationId: string): FileSearchChoice | null {
  const fallback = unavailableStorage.get(conversationId);
  if (fallback) {
    return fallback;
  }
  try {
    const choice = JSON.parse(
      localStorage.getItem(`${FILE_SEARCH_CHOICE_PREFIX}${conversationId}`) ?? 'null',
    ) as FileSearchChoice | null;
    return choice &&
      (choice.revision === null || typeof choice.revision === 'string') &&
      typeof choice.enabled === 'boolean'
      ? choice
      : null;
  } catch {
    return null;
  }
}

export function getFileSearchChoice(conversationId: string): FileSearchChoice | null {
  return readFileSearchChoice(resolveComposerConversationId(conversationId));
}

export function transferFileSearchChoice(sourceId: string, targetId: string): boolean | undefined {
  const source = readFileSearchChoice(sourceId);
  const target = readFileSearchChoice(targetId);
  if (!target && source) {
    try {
      localStorage.setItem(`${FILE_SEARCH_CHOICE_PREFIX}${targetId}`, JSON.stringify(source));
    } catch {
      unavailableStorage.set(targetId, source);
    }
  }
  return target && target.revision !== source?.revision ? target.enabled : undefined;
}

function writeFileSearchChoice(conversationId: string, choice: FileSearchChoice): void {
  try {
    localStorage.setItem(`${FILE_SEARCH_CHOICE_PREFIX}${conversationId}`, JSON.stringify(choice));
    unavailableStorage.delete(conversationId);
  } catch {
    unavailableStorage.set(conversationId, choice);
  }
}

/** Only explicit toggles advance the revision; accepted uploads retain it. */
export function setFileSearchChoice(conversationId: string, enabled: boolean): void {
  writeFileSearchChoice(resolveComposerConversationId(conversationId), { revision: v4(), enabled });
}

export function acceptFileSearchChoice(conversationId: string, revision: string | null): boolean {
  conversationId = resolveComposerConversationId(conversationId);
  const choice = readFileSearchChoice(conversationId);
  if (choice && choice.revision !== revision && !choice.enabled) return false;
  if (!choice?.enabled) {
    writeFileSearchChoice(conversationId, { revision: choice?.revision ?? null, enabled: true });
  }
  return true;
}

export function clearFileSearchChoices(): void {
  unavailableStorage.clear();
}
