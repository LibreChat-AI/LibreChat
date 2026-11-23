import path from 'path';
import { randomUUID } from 'crypto';
import { logger, escapeRegExp } from '@librechat/data-schemas';
import { Constants, ContentTypes, AnnotationTypes } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { settleAll, settleStarted } from '~/utils/promises';
import { announceReply } from '~/conversations/announce';

/** A content part of a thread message, as the provider returns it. */
export interface ThreadContentPart {
  type: string;
  [key: string]: unknown;
}

/** The thread message fields synchronization and processing read. */
export interface ThreadMessage {
  id: string;
  role: string;
  created_at: number;
  content: ThreadContentPart[];
  metadata?: { messageId?: string } | null;
  assistant_id?: string | null;
  file_ids?: string[];
  files?: unknown[];
  model?: string;
}

/** A LibreChat message as synchronization builds or reuses it. */
export interface SyncedMessage {
  messageId: string;
  parentMessageId?: string;
  role?: string;
  content?: unknown[];
  files?: unknown[];
  aggregateMessages?: { id: string }[];
  [key: string]: unknown;
}

/** The request fields synchronization reads off the Assistants client. */
export interface ThreadRequest {
  user: { id: string };
  body?: { isTemporary?: boolean };
  config?: { interfaceConfig?: AppConfig['interfaceConfig'] };
  resolvedConversation?: { isTemporary?: boolean; expiredAt?: Date; [key: string]: unknown };
}

/** The slice of the OpenAI client synchronization uses. */
export interface ThreadSyncClient {
  req: ThreadRequest;
  beta: {
    threads: {
      messages: {
        update: (
          messageId: string,
          params: { thread_id: string; metadata: { messageId: string } },
        ) => Promise<unknown>;
      };
    };
  };
}

/** Who a write belongs to and how long it is kept. */
export interface ThreadWriteContext {
  userId: string;
  isTemporary?: boolean;
  expiredAt?: Date;
  interfaceConfig?: AppConfig['interfaceConfig'];
}

export interface ThreadSyncDeps {
  /** Upserts a message; resolves with the stored row, or empty when nothing was written. */
  saveMessage: (
    ctx: ThreadWriteContext,
    message: SyncedMessage & { user: string },
  ) => Promise<Record<string, unknown> | null | undefined>;
  /** Merges `update` into the conversation; resolves with the stored conversation, if any. */
  saveConvo: (
    ctx: ThreadWriteContext,
    update: { conversationId: string; file_ids: string[] },
    options: { context: string },
  ) => Promise<Record<string, unknown> | null | undefined>;
  stampConvoLastResponse: (
    user: string,
    conversationId: string,
    messageId: string,
  ) => Promise<unknown>;
  /** Tags every provider message an aggregated reply was built from with its LibreChat id. */
  addThreadMetadata: (params: {
    openai: ThreadSyncClient;
    thread_id: string;
    messageId: string;
    messages: { id: string }[];
  }) => Promise<unknown>;
}

export interface SyncMessagesParams {
  openai: ThreadSyncClient;
  endpoint: string;
  thread_id: string;
  dbMessages: SyncedMessage[];
  apiMessages: ThreadMessage[];
  assistant_id?: string;
  conversationId: string;
}

/**
 * Synchronizes LibreChat messages to thread messages: saves the thread messages LibreChat is
 * missing, tags them on the thread with their LibreChat ids, and records the files users attached
 * on the conversation.
 *
 * Every save and thread update it starts settles before it returns or throws, so a failed update
 * or a throw partway through cannot leave a save landing after the caller settled, which on a
 * stopped run would recreate data for an owner being deleted.
 */
export async function syncMessages(
  deps: ThreadSyncDeps,
  {
    openai,
    endpoint,
    thread_id,
    dbMessages,
    apiMessages,
    assistant_id,
    conversationId,
  }: SyncMessagesParams,
): Promise<SyncedMessage[]> {
  const result: SyncedMessage[] = [];
  const dbMessageMap = new Map(dbMessages.map((msg) => [msg.messageId, msg]));

  const modifyPromises: Promise<unknown>[] = [];
  const recordPromises: Promise<unknown>[] = [];
  const ctx: ThreadWriteContext = {
    userId: openai.req.user.id,
    isTemporary: openai.req.resolvedConversation?.isTemporary ?? openai.req.body?.isTemporary,
    expiredAt: openai.req.resolvedConversation?.expiredAt,
    interfaceConfig: openai.req.config?.interfaceConfig,
  };
  /** The assistant writes this synchronization performed. Their results decide whether a reply
   *  is actually in the history: a write that resolved empty must not raise an indicator. */
  const assistantRecordPromises: Promise<Record<string, unknown> | null | undefined>[] = [];

  /** Saves `dbMessage` and tags its thread message with the LibreChat id. */
  const processNewMessage = (dbMessage: SyncedMessage, apiMessage: ThreadMessage) => {
    const recorded = deps.saveMessage(ctx, { ...dbMessage, user: openai.req.user.id });
    recordPromises.push(recorded);
    if (dbMessage.role === 'assistant') {
      assistantRecordPromises.push(recorded);
    }

    if (!apiMessage.id.includes('msg_')) {
      return;
    }

    if ((dbMessage.aggregateMessages?.length ?? 0) > 1) {
      modifyPromises.push(
        deps.addThreadMetadata({
          openai,
          thread_id,
          messageId: dbMessage.messageId,
          messages: dbMessage.aggregateMessages ?? [],
        }),
      );
      return;
    }

    modifyPromises.push(
      openai.beta.threads.messages.update(apiMessage.id, {
        thread_id,
        metadata: { messageId: dbMessage.messageId },
      }),
    );
  };

  let lastMessage: SyncedMessage | null = null;
  /** The newest provider message of an assistant reply not yet saved. A reply can span several
   *  provider messages, so it is saved once, when its run of assistant messages ends. */
  let pending: ThreadMessage | null = null;
  const flush = () => {
    if (pending && lastMessage) {
      processNewMessage(lastMessage, pending);
    }
    pending = null;
  };

  await settleStarted(
    () => {
      for (const apiMessage of apiMessages) {
        /* Whether the message exists in the database, by its metadata */
        const dbMessageId = apiMessage.metadata?.messageId;
        const dbMessage = dbMessageId != null ? dbMessageMap.get(dbMessageId) : undefined;
        const continues =
          apiMessage.role === 'assistant' &&
          lastMessage?.role === 'assistant' &&
          (!dbMessage || dbMessage === lastMessage);

        if (!continues) {
          flush();
        }

        /* Every provider message of an aggregated reply carries the same LibreChat id */
        if (dbMessage && dbMessage === lastMessage) {
          continue;
        }

        if (dbMessage) {
          dbMessage.parentMessageId = lastMessage ? lastMessage.messageId : Constants.NO_PARENT;
          lastMessage = dbMessage;
          result.push(dbMessage);
          continue;
        }

        if (continues && lastMessage) {
          /* Aggregate consecutive assistant messages */
          lastMessage.content = [...(lastMessage.content ?? []), ...apiMessage.content];
          lastMessage.files = [...(lastMessage.files ?? []), ...(apiMessage.files ?? [])];
          /* A row read back from the database carries no aggregation list of its own */
          lastMessage.aggregateMessages = [
            ...(lastMessage.aggregateMessages ?? []),
            { id: apiMessage.id },
          ];
          pending = apiMessage;
          continue;
        }

        const newMessage: SyncedMessage = {
          thread_id,
          conversationId,
          messageId: randomUUID(),
          endpoint,
          parentMessageId: lastMessage ? lastMessage.messageId : Constants.NO_PARENT,
          role: apiMessage.role,
          isCreatedByUser: apiMessage.role === 'user',
          // TODO: process generated files in content parts
          content: apiMessage.content,
          aggregateMessages: [{ id: apiMessage.id }],
          model: apiMessage.role === 'user' ? null : apiMessage.assistant_id,
          user: openai.req.user.id,
          unfinished: false,
        };

        if (apiMessage.file_ids?.length) {
          // TODO: retrieve file objects from API
          newMessage.files = apiMessage.file_ids.map((file_id) => ({ file_id }));
        }

        /* Assign assistant_id if defined */
        if (assistant_id && apiMessage.role === 'assistant' && !newMessage.model) {
          apiMessage.model = assistant_id;
          newMessage.model = assistant_id;
        }

        result.push(newMessage);
        lastMessage = newMessage;

        if (apiMessage.role === 'user') {
          processNewMessage(newMessage, apiMessage);
        } else if (apiMessage.role === 'assistant') {
          pending = apiMessage;
        }
      }
      flush();
    },
    () => [...modifyPromises, ...recordPromises],
  );

  const attached_file_ids = apiMessages.reduce<string[]>((acc, msg) => {
    if (msg.role === 'user' && msg.file_ids?.length) {
      return [...acc, ...msg.file_ids];
    }
    return acc;
  }, []);

  const recordedAssistantReplies = await Promise.all(assistantRecordPromises);

  const savedConvo = await deps.saveConvo(
    ctx,
    { conversationId, file_ids: attached_file_ids },
    { context: 'packages/api/src/assistants/threads.ts #syncMessages' },
  );
  if (savedConvo != null) {
    openai.req.resolvedConversation = savedConvo as ThreadRequest['resolvedConversation'];
  }

  /* Every caller that reaches here recovers assistant output the normal save path never wrote:
     a cancelled run, or one that errored after the model had already produced content. The
     `saveConvo` above carries no reply stamp, so without this the recovered reply would never
     raise its unseen indicator. Only a write that actually persisted counts, and it is
     best-effort, since those messages are already durable.
     A run cancelled before any output still persists the synthetic row `checkMessageGaps`
     built, and the error handlers add their visible content to the returned object rather
     than to that row: stamping it would raise a dot for a message that renders nothing, and
     acknowledgement requires the stamped reply to be on screen. */
  let persistedAssistantReply: Record<string, unknown> | undefined;
  for (let i = recordedAssistantReplies.length - 1; i >= 0 && !persistedAssistantReply; i--) {
    persistedAssistantReply = recordedAssistantReplies[i] ?? undefined;
  }
  await announceReply(
    { stampConvoLastResponse: deps.stampConvoLastResponse },
    {
      userId: openai.req.user.id,
      conversationId,
      reply: { ...persistedAssistantReply, isTemporary: ctx.isTemporary },
      context: 'syncMessages',
    },
  );

  return result;
}

/** A file record the retrieval produced. */
export interface RetrievedFile {
  filename?: string;
  filepath?: string;
  [key: string]: unknown;
}

/** The LibreChat client that manages the run: `OpenAI` or `StreamRunManager`. */
export interface ThreadRunClient {
  processedFileIds: Set<string>;
}

export interface RetrieveFileParams<TOpenAI, TClient> {
  openai: TOpenAI;
  client: TClient;
  file_id: string;
  basename?: string;
  unknownType?: boolean;
}

export interface ProcessMessagesDeps<TOpenAI, TClient> {
  /** Downloads a thread file, stores it and creates its record. */
  retrieveAndProcessFile: (
    params: RetrieveFileParams<TOpenAI, TClient>,
  ) => Promise<RetrievedFile | null | undefined>;
}

export interface ProcessMessagesParams<TOpenAI, TClient> {
  openai: TOpenAI;
  client: TClient;
  messages?: ThreadMessage[];
}

interface TextAnnotation {
  type: string;
  text: string;
  start_index: number;
  end_index: number;
  [key: string]: unknown;
}

interface TextContent {
  value?: string;
  file_id?: string;
  annotations?: TextAnnotation[];
}

const uniqueCitationStart = '^====||===';
const uniqueCitationEnd = '==|||||^';
interface CitationPatterns {
  adjacent: RegExp;
  remaining: RegExp;
  start: RegExp;
  end: RegExp;
}

let citationPatterns: CitationPatterns | undefined;

/**
 * Compiled once, on first use rather than at load: specs that mock `@librechat/data-schemas`
 * down to its logger still load this package, so loading it must not call `escapeRegExp`.
 */
function getCitationPatterns(): CitationPatterns {
  if (citationPatterns) {
    return citationPatterns;
  }
  const start = escapeRegExp(uniqueCitationStart);
  const end = escapeRegExp(uniqueCitationEnd);
  citationPatterns = {
    adjacent: new RegExp(`${start}(\\d+)${end}(\\s*)${start}(\\d+)${end}`, 'g'),
    remaining: new RegExp(`(${start}(\\d+)${end})\\s*\\1+`, 'g'),
    start: new RegExp(start, 'g'),
    end: new RegExp(end, 'g'),
  };
  return citationPatterns;
}

/**
 * Sorts thread messages, retrieves the files they reference, and flattens them to one string with
 * file paths and citations resolved.
 *
 * Every file retrieval it starts settles before it returns or throws: each one stores a file and
 * creates its record, so a throw partway through must not leave one landing after the caller
 * settled.
 */
export async function processMessages<TOpenAI, TClient extends ThreadRunClient>(
  deps: ProcessMessagesDeps<TOpenAI, TClient>,
  { openai, client, messages = [] }: ProcessMessagesParams<TOpenAI, TClient>,
): Promise<{ messages: ThreadMessage[]; text: string; edited: boolean }> {
  const sorted = messages.sort((a, b) => a.created_at - b.created_at);

  let text = '';
  let edited = false;
  const sources = new Map<string, number>();
  const fileRetrievalPromises: Promise<void>[] = [];

  await settleStarted(
    async () => {
      for (const message of sorted) {
        const files: unknown[] = [];
        message.files = files;
        for (const content of message.content) {
          const type = content.type;
          const contentType = content[type] as TextContent | undefined;
          const currentFileId = contentType?.file_id;

          if (
            type === ContentTypes.IMAGE_FILE &&
            !client.processedFileIds.has(currentFileId as string)
          ) {
            fileRetrievalPromises.push(
              deps
                .retrieveAndProcessFile({
                  openai,
                  client,
                  file_id: currentFileId as string,
                  basename: `${currentFileId}.png`,
                })
                .then((file) => {
                  client.processedFileIds.add(currentFileId as string);
                  files.push(file);
                })
                .catch((error) => {
                  logger.error(`Failed to retrieve file: ${(error as Error).message}`);
                }),
            );
            continue;
          }

          let currentText = contentType?.value ?? '';
          const annotations = contentType?.annotations;

          if (!annotations?.length) {
            text += currentText;
            continue;
          }

          const replacements: { start: number; end: number; text: string }[] = [];
          const annotationPromises = annotations.map(async (annotation) => {
            const type = annotation.type;
            const annotationType = annotation[type] as { file_id?: string } | undefined;
            const file_id = annotationType?.file_id as string;
            const alreadyProcessed = client.processedFileIds.has(file_id);

            let file: RetrievedFile | null | undefined;
            let replacementText = '';

            try {
              /* A file an earlier message already attached is only looked up again, but its
                 path or citation still resolves in this text. */
              if (type === AnnotationTypes.FILE_PATH) {
                file = await deps.retrieveAndProcessFile(
                  alreadyProcessed
                    ? { openai, client, file_id, unknownType: true }
                    : { openai, client, file_id, basename: path.basename(annotation.text) },
                );
                replacementText = (file as RetrievedFile).filepath as string;
              } else if (type === AnnotationTypes.FILE_CITATION && file_id) {
                file = await deps.retrieveAndProcessFile({
                  openai,
                  client,
                  file_id,
                  unknownType: true,
                });
                if (file && file.filename) {
                  if (!sources.has(file.filename)) {
                    sources.set(file.filename, sources.size + 1);
                  }
                  replacementText = `${uniqueCitationStart}${sources.get(file.filename)}${uniqueCitationEnd}`;
                }
              } else if (alreadyProcessed) {
                file = await deps.retrieveAndProcessFile({
                  openai,
                  client,
                  file_id,
                  unknownType: true,
                });
              }

              if (file && replacementText) {
                replacements.push({
                  start: annotation.start_index,
                  end: annotation.end_index,
                  text: replacementText,
                });
                edited = true;
                if (!alreadyProcessed) {
                  client.processedFileIds.add(file_id);
                  files.push(file);
                }
              }
            } catch (error) {
              logger.error(`Failed to process annotation: ${(error as Error).message}`);
            }
          });

          await settleAll(annotationPromises);

          /* Apply replacements in reverse order */
          replacements.sort((a, b) => b.start - a.start);
          for (const { start, end, text: replacementText } of replacements) {
            currentText = currentText.slice(0, start) + replacementText + currentText.slice(end);
          }

          text += currentText;
        }
      }
    },
    () => fileRetrievalPromises,
  );

  /* Collapse adjacent identical citations in the unique format */
  const patterns = getCitationPatterns();
  text = text.replace(patterns.adjacent, (_match, num1, space, num2) => {
    return num1 === num2
      ? `${uniqueCitationStart}${num1}${uniqueCitationEnd}`
      : `${uniqueCitationStart}${num1}${uniqueCitationEnd}${space}${uniqueCitationStart}${num2}${uniqueCitationEnd}`;
  });
  text = text.replace(patterns.remaining, '$1');

  /* Replace the unique citation format with the final format */
  text = text.replace(patterns.start, '^');
  text = text.replace(patterns.end, '^');

  if (sources.size) {
    text += '\n\n';
    Array.from(sources.entries()).forEach(([source, index], arrayIndex) => {
      text += `^${index}.^ ${source}${arrayIndex === sources.size - 1 ? '' : '\n'}`;
    });
  }

  return { messages: sorted, text, edited };
}
