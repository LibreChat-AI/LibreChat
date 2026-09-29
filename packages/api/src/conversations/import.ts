import { BSON, ObjectId } from 'mongodb';

import type { Document } from 'mongodb';

export const MAX_CONVERSATION_IMPORT_BSON_BYTES: number = 16 * 1024 * 1024;
export const CONVERSATION_IMPORT_BSON_HEADROOM_BYTES: number = 64 * 1024;
export const MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES: number =
  MAX_CONVERSATION_IMPORT_BSON_BYTES - CONVERSATION_IMPORT_BSON_HEADROOM_BYTES;

export interface ConversationImportWriteBatch {
  conversations: readonly Document[];
  messages: readonly Document[];
  tenantId?: string;
}

export interface ConversationImportWriteOperations {
  saveConversations: () => Promise<void>;
  saveMessages: () => Promise<void>;
  updateTagCounts: () => Promise<void>;
  deleteMessages: () => Promise<void>;
  deleteConversations: () => Promise<void>;
  onTagCountError?: (error: Error) => void;
  onCleanupError?: (error: Error, resource: 'messages' | 'conversations') => void;
}

export class ConversationImportError extends Error {
  readonly code = 'invalid_request';
  readonly statusCode: number;
  readonly body: { error: 'invalid_request'; message: string };

  constructor(message: string, statusCode: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConversationImportError';
    this.statusCode = statusCode;
    this.body = { error: 'invalid_request', message };
  }
}

function importWriteError(
  message: string,
  statusCode: number,
  cause?: unknown,
): ConversationImportError {
  return new ConversationImportError(
    message,
    statusCode,
    cause === undefined ? undefined : { cause },
  );
}

export function isConversationImportError(error: unknown): error is ConversationImportError {
  return error instanceof ConversationImportError;
}

export function assertConversationImportWriteSize(batch: ConversationImportWriteBatch): void {
  const assertDocumentSize = (document: Document): void => {
    let size: number;
    try {
      size = BSON.calculateObjectSize({
        ...document,
        _id: new ObjectId(),
        __v: 0,
        ...(batch.tenantId == null ? {} : { tenantId: batch.tenantId }),
      });
    } catch (error) {
      throw importWriteError('An imported conversation or message cannot be stored', 400, error);
    }
    if (size > MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES) {
      throw importWriteError(
        `Each imported conversation or message must be at most ${MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES} bytes`,
        413,
      );
    }
  };
  for (const conversation of batch.conversations) {
    assertDocumentSize(conversation);
  }
  for (const message of batch.messages) {
    assertDocumentSize(message);
  }
}

export async function executeConversationImportWrites(
  operations: ConversationImportWriteOperations,
): Promise<void> {
  try {
    await operations.saveConversations();
    await operations.saveMessages();
  } catch (error) {
    try {
      await operations.deleteMessages();
    } catch (cleanupError) {
      operations.onCleanupError?.(
        cleanupError instanceof Error
          ? cleanupError
          : new Error('Failed to clean imported messages'),
        'messages',
      );
      throw error;
    }

    try {
      await operations.deleteConversations();
    } catch (cleanupError) {
      operations.onCleanupError?.(
        cleanupError instanceof Error
          ? cleanupError
          : new Error('Failed to clean imported conversations'),
        'conversations',
      );
    }
    throw error;
  }

  try {
    await operations.updateTagCounts();
  } catch (error) {
    operations.onTagCountError?.(
      error instanceof Error ? error : new Error('Failed to update imported tag counts'),
    );
  }
}
