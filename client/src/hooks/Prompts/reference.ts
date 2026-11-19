import type {
  ProductPromptReference,
  TPromptGroup,
  TResolvedPromptResponse,
} from 'librechat-data-provider';

/** Keep the resolved group identity, never its revision or content. */
export function getProductPromptReference(
  group: TPromptGroup | undefined,
  resolved?: TResolvedPromptResponse,
): ProductPromptReference | undefined {
  if (!group?._id) {
    return;
  }
  if (group.source === 'langfuse') {
    return resolved?.source === 'langfuse' ? { source: 'langfuse', groupId: group._id } : undefined;
  }
  const promptId = resolved?.source === 'native' ? resolved.promptId : group.productionId;
  return promptId ? { source: 'native', groupId: group._id } : undefined;
}
