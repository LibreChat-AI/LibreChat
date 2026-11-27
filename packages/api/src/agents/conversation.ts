import type { TConversation, CodeWorkspaceSelection } from 'librechat-data-provider';

/** Never turn another conversation's stored workspace into an explicit run selection. */
export function resolveRunCodeWorkspaces({
  conversationId,
  requestedSelections,
  conversation,
}: {
  conversationId: string;
  requestedSelections?: CodeWorkspaceSelection[] | null;
  conversation?: Pick<TConversation, 'conversationId' | 'codeWorkspaces'> | null;
}): CodeWorkspaceSelection[] | undefined {
  return (
    requestedSelections ??
    (conversation?.conversationId === conversationId ? conversation.codeWorkspaces : undefined)
  );
}

/** Reuse resolved state only for the conversation the run will actually execute. */
export async function resolveRunConversation<TConversation>({
  request,
  conversationId,
  loadConversation,
}: {
  request: {
    body?: { conversationId?: string };
    resolvedConversation?: TConversation | null;
  };
  conversationId?: string;
  loadConversation: (conversationId: string) => Promise<TConversation | null | undefined>;
}): Promise<TConversation | null | undefined> {
  if (
    conversationId === request.body?.conversationId &&
    Object.prototype.hasOwnProperty.call(request, 'resolvedConversation')
  ) {
    return request.resolvedConversation;
  }
  if (typeof conversationId !== 'string' || conversationId === '') {
    return null;
  }
  return loadConversation(conversationId);
}

export interface ConversationAnchorSource {
  createdAt?: Date | string | number | null;
}

export interface ConversationAnchor<TConversation extends ConversationAnchorSource> {
  createdAt: string;
  conversation: TConversation | null | undefined;
}

interface ResolveConversationAnchorOptions<TConversation extends ConversationAnchorSource> {
  isNewConversation: boolean;
  loadConversation: () => Promise<TConversation | null | undefined>;
  now?: () => Date;
  onLoadError?: (error: Error) => void;
}

function toValidISOString(value: Date | string | number | null | undefined): string | undefined {
  if (value == null) {
    return;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export async function resolveConversationAnchor<TConversation extends ConversationAnchorSource>({
  isNewConversation,
  loadConversation,
  now = () => new Date(),
  onLoadError,
}: ResolveConversationAnchorOptions<TConversation>): Promise<ConversationAnchor<TConversation>> {
  if (isNewConversation) {
    return {
      createdAt: now().toISOString(),
      conversation: undefined,
    };
  }

  try {
    const conversation = await loadConversation();
    return {
      createdAt: toValidISOString(conversation?.createdAt) ?? now().toISOString(),
      conversation,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    onLoadError?.(normalizedError);
    return {
      createdAt: now().toISOString(),
      conversation: undefined,
    };
  }
}
