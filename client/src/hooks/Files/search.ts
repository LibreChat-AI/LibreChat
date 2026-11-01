import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import type { TEphemeralAgent } from 'librechat-data-provider';
import type { CapturedComposerDraft } from '~/utils/drafts';
import {
  getFileSearchChoice,
  transferFileSearchChoice,
  acceptFileSearchChoice,
} from '~/utils/choices';
import { getTimestampedValue, isTimestampExpired, setTimestamp } from '~/utils/timestamps';
import { getNewConversationDraftRevision } from '~/utils/drafts';
import { FILE_SEARCH_UPLOAD_PREFIX } from '~/utils/localStorage';

const keyFor = (fileId: string) => `${FILE_SEARCH_UPLOAD_PREFIX}${fileId}`;

export type FileSearchUploadContext = Readonly<{
  conversationId: string;
  choiceRevision: string | null;
  createdAt: number;
  projectId?: string | null;
  newChatGeneration?: Readonly<{ index: number; revision: string }>;
}>;
type Intent = FileSearchUploadContext;
const owners = new WeakMap<FileSearchUploadContext, CapturedComposerDraft>();
const assignments = new Map<string, { owner: CapturedComposerDraft; dispose: () => void }>();

export function transferFileSearchPreference(
  sourceId: string,
  targetId: string,
): boolean | undefined {
  let enabled = transferFileSearchChoice(sourceId, targetId);
  const targetKey = `${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}${targetId}`;
  try {
    const preference =
      getTimestampedValue(targetKey) ??
      getTimestampedValue(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}${sourceId}`);
    if (enabled == null && (preference === 'true' || preference === 'false')) {
      enabled = preference === 'true';
    }
    if (enabled != null) {
      localStorage.setItem(targetKey, JSON.stringify(enabled));
      setTimestamp(targetKey);
    }
  } catch {
    // A blocked store must not prevent the acknowledged identity handoff.
  }
  return enabled;
}

export function getFileSearchPreference(conversationId: string): boolean | undefined {
  const choice = getFileSearchChoice(conversationId);
  if (choice) return choice.enabled;
  try {
    const preference = getTimestampedValue(
      `${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}${conversationId}`,
    );
    if (preference === 'true' || preference === 'false') return preference === 'true';
  } catch {
    // Unavailable storage leaves the live template as the fallback.
  }
  return undefined;
}

/** Acknowledgements cannot replay a tool snapshot over accepted uploads or later toggles. */
export function withFileSearchPreference(
  conversationId: string,
  agent: TEphemeralAgent | null | undefined,
): TEphemeralAgent | null | undefined {
  const enabled = getFileSearchPreference(conversationId);
  return enabled == null || enabled === agent?.file_search
    ? agent
    : { ...agent, file_search: enabled };
}

export function captureFileSearchUpload(
  conversationId: string,
  owner?: CapturedComposerDraft,
): FileSearchUploadContext {
  const context = {
    get conversationId() {
      return owner?.conversationId() ?? conversationId;
    },
    choiceRevision: getFileSearchChoice(conversationId)?.revision ?? null,
    createdAt: Date.now(),
    projectId: new URLSearchParams(window.location.search).get('projectId'),
    newChatGeneration:
      conversationId === Constants.NEW_CONVO
        ? (owner?.newChatGeneration ?? { index: 0, revision: getNewConversationDraftRevision(0) })
        : undefined,
  };
  if (owner) owners.set(context, owner);
  return context;
}

export function beginFileSearchUpload(
  fileId: string,
  operation: string | FileSearchUploadContext,
): { choiceRevision: string | null; persisted: boolean } {
  const context = typeof operation === 'string' ? captureFileSearchUpload(operation) : operation;
  const { choiceRevision } = context;
  assignments.get(fileId)?.dispose();
  const owner = owners.get(context);
  if (owner?.registered) {
    assignments.set(fileId, {
      owner,
      dispose: owner.onAssignment((sourceId, targetId) => {
        transferFileSearchPreference(sourceId, targetId);
        try {
          localStorage.setItem(keyFor(fileId), JSON.stringify(context));
        } catch {
          /* Live recovery owns completion. */
        }
      }),
    });
  }
  try {
    localStorage.setItem(keyFor(fileId), JSON.stringify(context));
    return { choiceRevision, persisted: true };
  } catch {
    // The live recovery callback still owns activation when storage is unavailable.
  }
  return { choiceRevision, persisted: false };
}

export function cancelFileSearchUpload(fileId: string): void {
  assignments.get(fileId)?.dispose();
  assignments.delete(fileId);
  try {
    localStorage.removeItem(keyFor(fileId));
  } catch {
    // Best-effort storage cleanup.
  }
}

function readIntent(fileId: string): Intent | null {
  let intent: Intent | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(keyFor(fileId)) ?? 'null') as Intent | null;
    if (
      value &&
      typeof value.conversationId === 'string' &&
      (value.choiceRevision === null || typeof value.choiceRevision === 'string') &&
      Number.isFinite(value.createdAt) &&
      !isTimestampExpired(value.createdAt)
    ) {
      intent = value;
    }
  } catch {
    // A live callback can recover without a stored record.
  }
  return intent;
}

/** Unknown attachments remain restorable; explicit uploads must still own their destination. */
export function canRestoreFileSearchUpload(
  fileId: string,
  conversationId: string,
  context?: FileSearchUploadContext,
): boolean {
  const intent = context ?? readIntent(fileId);
  const owner = assignments.get(fileId)?.owner ?? (context ? owners.get(context) : undefined);
  if (
    owner &&
    (owner.conversationId() !== conversationId || (!owner() && !owner.retainsFile(fileId)))
  ) {
    return false;
  }
  if (!intent) return true;
  if (intent.conversationId !== conversationId) return owner == null;
  if (conversationId !== Constants.NEW_CONVO) return true;
  const generation = intent.newChatGeneration;
  return (
    generation != null &&
    Number.isInteger(generation.index) &&
    generation.index >= 0 &&
    generation.revision === getNewConversationDraftRevision(generation.index) &&
    (intent.projectId === undefined ||
      intent.projectId === new URLSearchParams(window.location.search).get('projectId'))
  );
}

export function hasPendingFileSearchUpload(fileId: string, conversationId: string): boolean {
  const intent = readIntent(fileId);
  return (
    intent?.conversationId === conversationId &&
    canRestoreFileSearchUpload(fileId, conversationId, intent)
  );
}

/** Completes only an explicit upload intent, never an arbitrary embedded attachment. */
export function completeFileSearchUpload(
  fileId: string,
  conversationId: string,
  choiceRevision?: string | null,
): boolean {
  const owner = assignments.get(fileId)?.owner;
  let intent = readIntent(fileId);
  intent ??=
    choiceRevision === undefined
      ? null
      : {
          conversationId,
          choiceRevision,
          createdAt: Date.now(),
          newChatGeneration:
            conversationId === Constants.NEW_CONVO
              ? (owner?.newChatGeneration ?? {
                  index: 0,
                  revision: getNewConversationDraftRevision(0),
                })
              : undefined,
        };
  if (!intent) {
    if (owner && !owner() && !owner.retainsFile(fileId)) {
      owner.discardFile(fileId);
      cancelFileSearchUpload(fileId);
    } else if (!owner) cancelFileSearchUpload(fileId);
    return false;
  }
  if (intent.conversationId !== conversationId) {
    return false;
  }
  if (!canRestoreFileSearchUpload(fileId, conversationId, intent)) {
    owner?.discardFile(fileId);
    cancelFileSearchUpload(fileId);
    return false;
  }
  cancelFileSearchUpload(fileId);
  if (!acceptFileSearchChoice(conversationId, intent.choiceRevision)) return false;
  const preferenceKey = `${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}${conversationId}`;
  try {
    localStorage.setItem(preferenceKey, 'true');
    setTimestamp(preferenceKey);
  } catch {
    // Persistence is best-effort; the accepted live upload must remain usable.
  }
  return true;
}
