import { createContext, useContext, useMemo } from 'react';
import type { TAttachment } from 'librechat-data-provider';
import type { Context } from 'react';

/** Files rendered beside the activity tree rather than inside its changing folds. */
export const HiddenAttachmentsContext: Context<ReadonlySet<TAttachment> | null> =
  createContext<ReadonlySet<TAttachment> | null>(null);

export function useVisibleAttachments(attachments?: TAttachment[]): TAttachment[] | undefined {
  const hidden = useContext(HiddenAttachmentsContext);
  return useMemo(
    () =>
      hidden == null || hidden.size === 0
        ? attachments
        : attachments?.filter((file) => !hidden.has(file)),
    [attachments, hidden],
  );
}
