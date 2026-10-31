import { useMemo } from 'react';
import { hasOmittedSubagentContent, routeStoredSubagentHints } from '@librechat/chat/react';
import type {
  TMessageContentParts,
  SubagentAttachmentFile,
  SubagentAttachmentCallsResponse,
} from 'librechat-data-provider';
import type { NestedCall } from '@librechat/chat/react';
import { useSubagentAttachmentCallsQueries } from '~/data-provider';

/**
 * Child calls of the stored transcripts of the previewed subagent calls in `content`, for the
 * files whose owner is in doubt, keyed by the call's index in `content`. A file a background task
 * delivers after the message loaded names a child call the cached preview never hinted; while
 * `files` is not empty, the server is asked (in bounded batches) which transcript holds each.
 */
export function useStoredSubagentHints(
  content: ReadonlyArray<TMessageContentParts | undefined> | undefined,
  files: SubagentAttachmentFile[],
  conversationId: string | null | undefined,
  messageId: string,
): ReadonlyMap<number, NestedCall[]> {
  const previewed = useMemo(() => hasOmittedSubagentContent(content), [content]);
  const results = useSubagentAttachmentCallsQueries(
    { conversationId: conversationId ?? '', messageId, files },
    previewed && files.length > 0 && !!conversationId && !!messageId,
  );
  /** A string, so the routing changes only when an answer does. */
  const answers = JSON.stringify(results.map((result) => result.data?.parts ?? null));
  return useMemo(() => {
    const parts = (
      JSON.parse(answers) as Array<SubagentAttachmentCallsResponse['parts'] | null>
    ).flatMap((batch) => batch ?? []);
    return routeStoredSubagentHints(previewed ? content : undefined, parts);
  }, [answers, previewed, content]);
}
