import { FileContext, FileSources } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';

export type FileRow = {
  id: string;
  name: string;
  type?: string;
  bytes?: number;
  /** How the model receives it: as the file itself, as text read from it, or not directly. */
  delivery: 'file' | 'text' | 'none';
  /** Indexed for file search. */
  search: boolean;
  /** Placed in the code environment. */
  code: boolean;
  /** Produced in the conversation rather than attached to it. */
  made: boolean;
};

type Ref = Partial<TFile> | null | undefined;

const codeContexts = new Set<string>([FileContext.execute_code, FileContext.execute_code_snapshot]);

/** Where a stored file goes, read the way the server decides what it sends to the model. */
function describe(file: Partial<TFile>, made: boolean): Omit<FileRow, 'id' | 'name'> {
  const metadata = file.metadata;
  const code =
    (file.context != null && codeContexts.has(file.context)) ||
    metadata?.codeDestination === true ||
    metadata?.codeEnvRef != null ||
    metadata?.codeEnvRefs != null ||
    metadata?.fileIdentifier != null;
  const search = file.embedded === true || metadata?.searchDestination === true;
  let delivery: FileRow['delivery'] = code || search ? 'none' : 'file';
  if (file.source === FileSources.text || file.llmDeliveryPath === 'text') {
    delivery = 'text';
  } else if (file.llmDeliveryPath === 'provider') {
    delivery = 'file';
  } else if (file.llmDeliveryPath === 'none') {
    delivery = 'none';
  }
  return {
    type: file.type,
    bytes: typeof file.bytes === 'number' && file.bytes > 0 ? file.bytes : undefined,
    delivery,
    search,
    code,
    made: made || (file.context != null && codeContexts.has(file.context)),
  };
}

function add(rows: FileRow[], file: Ref, made: boolean): void {
  if (file == null || typeof file.file_id !== 'string' || file.file_id === '') {
    return;
  }
  rows.push({
    id: file.file_id,
    name: file.filename || file.file_id,
    ...describe(file, made),
  });
}

const none: readonly FileRow[] = [];
const known = new WeakMap<TMessage, readonly FileRow[]>();

/**
 * The files one message carries, in the three places a later turn collects them from: its
 * uploads, the files its tools produced, and the files attached to a steer. Kept per message
 * object: while a response streams only the last message is a new object each frame, so a
 * thread is not read again for every token.
 */
function messageFiles(message: TMessage): readonly FileRow[] {
  const cached = known.get(message);
  if (cached != null) {
    return cached;
  }
  const rows: FileRow[] = [];
  for (const file of message.files ?? []) {
    add(rows, file, false);
  }
  for (const attachment of message.attachments ?? []) {
    add(rows, attachment as Ref, true);
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const files = (part as { files?: Ref[] } | undefined)?.files;
      if (Array.isArray(files)) {
        for (const file of files) {
          add(rows, file, false);
        }
      }
    }
  }
  const result = rows.length === 0 ? none : rows;
  known.set(message, result);
  return result;
}

/** Every file the loaded messages carry, newest first, each listed once. */
export function collectFiles(messages: TMessage[] | null | undefined): FileRow[] {
  const rows: FileRow[] = [];
  if (messages == null) {
    return rows;
  }
  const listed = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const row of messageFiles(messages[index])) {
      if (!listed.has(row.id)) {
        listed.add(row.id);
        rows.push(row);
      }
    }
  }
  return rows;
}
