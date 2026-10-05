import {
  collectMessageFileIds,
  removeMessageFileIds,
  isMediaFileId,
} from '@librechat/data-schemas';
import type { MediaMethods, MediaOwnerScope } from '@librechat/data-schemas';

/** Drop unavailable media before content inspection; persistence fences later deletion races. */
export async function prepareMediaConversationImport({
  scope,
  messages,
  getAvailableMediaFileIds,
}: {
  scope: MediaOwnerScope;
  messages: ReadonlyArray<Parameters<typeof collectMessageFileIds>[0]>;
  getAvailableMediaFileIds: MediaMethods['getAvailableMediaFileIds'];
}): Promise<void> {
  const requested = new Set<string>();
  for (const message of messages) {
    for (const fileId of collectMessageFileIds(message)) {
      if (isMediaFileId(fileId)) requested.add(fileId);
    }
  }
  if (!requested.size) return;
  const available = await getAvailableMediaFileIds({ scope, fileIds: [...requested] });
  for (const fileId of available) requested.delete(fileId);
  if (!requested.size) return;
  for (const message of messages) {
    Object.assign(message, removeMessageFileIds(message, requested));
  }
}
