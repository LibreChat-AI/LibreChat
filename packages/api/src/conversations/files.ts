import { isFileAttachment, isFileContentPart, hasContentPartFiles } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';
import { ATTACHMENT_ONLY_TEXT } from '~/files/context';

type MessageFileRefs = Partial<
  Pick<TMessage, 'files' | 'attachments' | 'tokenCount' | 'content' | 'text' | 'isCreatedByUser'>
>;

type ConversationFileRefs = Partial<Pick<TConversation, 'file_ids'>> & {
  files?: string[] | null;
  excludedFiles?: string[] | null;
};

type ContentPart = NonNullable<TMessage['content']>[number];

export type MessageWithoutFiles<T extends MessageFileRefs> = Omit<
  T,
  'files' | 'attachments' | 'tokenCount'
> &
  Pick<MessageFileRefs, 'attachments' | 'tokenCount'>;

/** A part's own attached files (a steer's) go; a part that is itself a file goes entirely. */
function withoutContentFiles(content: ContentPart[]): ContentPart[] {
  let changed = false;
  const kept: ContentPart[] = [];
  for (const part of content) {
    if (isFileContentPart(part)) {
      changed = true;
      continue;
    }
    if (!hasContentPartFiles(part)) {
      kept.push(part);
      continue;
    }
    changed = true;
    const { files: _files, ...rest } = part as ContentPart & { files?: readonly object[] };
    kept.push(rest as ContentPart);
  }
  return changed ? kept : content;
}

/**
 * Drops every file reference a later turn collects from history and sends again, in the shapes
 * historical replay reads (`messageCarriesFiles`): uploads on a user turn (`files`), file-backed
 * attachments such as code outputs (metadata-only ones like search sources stay), and file
 * references in the content (a steered attachment, a generated image, a provider file block). A
 * stored token count that covered a dropped file goes too, so the next turn recounts what is left
 * instead of budgeting context for files it no longer sends.
 */
export function withoutMessageFiles<T extends MessageFileRefs>(message: T): MessageWithoutFiles<T> {
  const { files, attachments, tokenCount, ...rest } = message;
  let droppedFiles = (files?.length ?? 0) > 0;
  const keptAttachments = attachments?.filter((attachment) => !isFileAttachment(attachment));
  if (keptAttachments != null && keptAttachments.length > 0) {
    (rest as MessageFileRefs).attachments = keptAttachments;
  }
  if (Array.isArray(rest.content)) {
    const content = withoutContentFiles(rest.content);
    if (content !== rest.content) {
      droppedFiles = true;
      rest.content = content;
    }
  }
  if (droppedFiles || tokenCount == null) {
    return rest;
  }
  return { ...rest, tokenCount };
}

/**
 * Drops the conversation-level file ids that turns without a branch anchor fall back to, and
 * with them the list of files left out, which names files the copy no longer has.
 */
export function withoutConversationFiles<T extends ConversationFileRefs>(
  conversation: T,
): Omit<T, 'files' | 'file_ids' | 'excludedFiles'> {
  const { files: _files, file_ids: _fileIds, excludedFiles: _excluded, ...rest } = conversation;
  return rest;
}

/**
 * How a copied conversation treats files: as they are, or with every reference a later turn would
 * send again left out (`excludeFiles`). Native copies (forks) apply it to each cloned message and
 * to the conversation, so the decision lives here rather than in each copy path.
 */
export function forkFileScope(excludeFiles = false): {
  message: <T extends MessageFileRefs>(message: T) => T | MessageWithoutFiles<T>;
  conversation: <T extends ConversationFileRefs>(
    conversation: T,
  ) => T | Omit<T, 'files' | 'file_ids' | 'excludedFiles'>;
} {
  if (excludeFiles !== true) {
    return { message: (message) => message, conversation: (conversation) => conversation };
  }
  return { message: withoutMessageFiles, conversation: withoutConversationFiles };
}

/** A conversation's left-out file ids as stored: absent, empty, or a list. */
type Excluded = readonly string[] | null | undefined;

type FileRef = { file_id?: string } | null | undefined;

const isExcludedRef = (ref: FileRef, excluded: ReadonlySet<string>): boolean =>
  typeof ref?.file_id === 'string' && excluded.has(ref.file_id);

/** The locators a content part can name a stored file by; `files` is a steer part's own list. */
type LocatorPart = {
  file?: FileRef;
  image_file?: FileRef;
  file_id?: string;
  files?: readonly FileRef[];
};

function withoutExcludedLocators(part: ContentPart, excluded: ReadonlySet<string>): ContentPart {
  if (part == null || typeof part !== 'object') {
    return part;
  }
  const locator = part as LocatorPart;
  const dropsFile = isExcludedRef(locator.file, excluded);
  const dropsImage = isExcludedRef(locator.image_file, excluded);
  const dropsId = typeof locator.file_id === 'string' && excluded.has(locator.file_id);
  const files = Array.isArray(locator.files) ? locator.files : undefined;
  const keptFiles = files?.filter((file) => !isExcludedRef(file, excluded));
  const dropsFiles = files != null && keptFiles != null && keptFiles.length !== files.length;
  if (!dropsFile && !dropsImage && !dropsId && !dropsFiles) {
    return part;
  }
  const kept: LocatorPart = { ...locator };
  if (dropsFile) {
    delete kept.file;
  }
  if (dropsImage) {
    delete kept.image_file;
  }
  if (dropsId) {
    delete kept.file_id;
  }
  if (dropsFiles) {
    kept.files = keptFiles;
  }
  return kept as ContentPart;
}

function withoutExcludedRefs<T extends MessageFileRefs>(
  message: T,
  excluded: ReadonlySet<string>,
): T {
  const files = message.files?.filter((file) => !isExcludedRef(file, excluded));
  const attachments = message.attachments?.filter(
    (attachment) => !isExcludedRef(attachment as FileRef, excluded),
  );
  const content = Array.isArray(message.content)
    ? message.content.map((part) => withoutExcludedLocators(part, excluded))
    : undefined;
  const changedFiles = files != null && files.length !== message.files?.length;
  const changedAttachments =
    attachments != null && attachments.length !== message.attachments?.length;
  const changedContent =
    content != null && content.some((part, index) => part !== message.content?.[index]);
  if (!changedFiles && !changedAttachments && !changedContent) {
    return message;
  }
  return {
    ...message,
    ...(changedFiles ? { files } : {}),
    ...(changedAttachments ? { attachments } : {}),
    ...(changedContent ? { content } : {}),
  };
}

/**
 * The stored messages as a turn that leaves `excluded` files out refers to them: every reference
 * to one of those files is gone, in the shapes historical replay reads. This is the view the
 * model-bound guard checks the turn against, so a file that is not sent is not looked up or
 * inspected either. A message that names none of them is returned as it is, and so is the array
 * when nothing changed, which is every turn of a conversation that leaves nothing out.
 *
 * The stored token count stays: it may still cover a left-out file, which over-budgets the
 * message, the safe side. Recounting here would persist a count that is too low once the file is
 * taken back in.
 */
export function withoutExcludedFiles<T extends MessageFileRefs>(
  messages: readonly T[],
  excluded: Excluded,
): readonly T[] {
  if (excluded == null || excluded.length === 0) {
    return messages;
  }
  const ids = new Set(excluded);
  let changed = false;
  const kept = messages.map((message) => {
    const next = withoutExcludedRefs(message, ids);
    changed ||= next !== message;
    return next;
  });
  return changed ? kept : messages;
}

/** A stored message with every file reference a turn that resends none of them would read. */
function withoutAnyRefs<T extends MessageFileRefs>(message: T): T {
  const { files: _files, attachments: _attachments, ...rest } = message;
  if (!Array.isArray(rest.content)) {
    return rest as T;
  }
  const content = rest.content.map((part) => {
    if (part == null || typeof part !== 'object') {
      return part;
    }
    const {
      file: _file,
      files: _partFiles,
      image_file: _image,
      file_id: _fileId,
      ...kept
    } = part as LocatorPart;
    return kept as ContentPart;
  });
  return { ...rest, content } as T;
}

/**
 * The stored messages as this turn refers to their files, which is what the model-bound guard
 * checks the turn against: with no file reference at all when the endpoint does not send earlier
 * files again, and otherwise with every reference but those to files the conversation leaves out.
 */
export function withoutUnsentFiles<T extends MessageFileRefs>(
  messages: readonly T[],
  { resendFiles, excluded }: { resendFiles?: boolean; excluded?: Excluded },
): readonly T[] {
  const view =
    resendFiles === false ? messages.map(withoutAnyRefs) : withoutExcludedFiles(messages, excluded);
  if (view === messages) {
    return messages;
  }
  return view.map((message, index) => withAttachmentOnlyText(messages[index], message));
}

/**
 * A user turn sent with nothing but files has no text of its own; while its files are sent, the
 * formatter gives it the attachment-only stand-in. A view that sends none of them keeps the
 * stand-in in their place, or the turn reaches the provider empty, which Anthropic rejects on
 * every later turn that replays it. The stored message keeps its empty text.
 */
function withAttachmentOnlyText<T extends MessageFileRefs>(stored: T, view: T): T {
  if (
    view === stored ||
    stored.isCreatedByUser !== true ||
    stored.text ||
    Array.isArray(stored.content) ||
    !stored.files?.length ||
    view.files?.length
  ) {
    return view;
  }
  return { ...view, text: ATTACHMENT_ONLY_TEXT };
}

export interface HistoricalReplayScope {
  fileIds: string[];
  steerFileIds: string[];
  /** Present only when something is left out: then nothing outside it may be replayed. */
  admitted?: ReadonlySet<string>;
}

/**
 * Which earlier files a turn may send again. Left-out files are taken out before the turn's
 * limits are checked, so they count toward none of them, and `admitted` closes the set for a
 * caller that applies no admission step of its own. With nothing left out the ids come back as
 * they were given and `admitted` is absent, which keeps today's behavior exactly.
 */
export function scopeHistoricalReplay({
  fileIds,
  steerFileIds,
  excluded,
}: {
  fileIds: string[];
  steerFileIds: string[];
  excluded: Excluded;
}): HistoricalReplayScope {
  if (excluded == null || excluded.length === 0) {
    return { fileIds, steerFileIds };
  }
  const ids = new Set(excluded);
  const kept = fileIds.filter((fileId) => !ids.has(fileId));
  const keptSteer = steerFileIds.filter((fileId) => !ids.has(fileId));
  return { fileIds: kept, steerFileIds: keptSteer, admitted: new Set([...kept, ...keptSteer]) };
}
