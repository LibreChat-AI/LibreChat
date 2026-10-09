import type { TMessage } from 'librechat-data-provider';

const even =
  'w-full border-b border-border-light text-text-primary bg-surface-secondary group hover:bg-surface-hover hover:text-text-primary';
const odd =
  'w-full border-b border-border-light text-text-primary group bg-surface-active-alt hover:bg-surface-hover hover:text-text-primary';

export function groupIntoList({
  messages,
}: // fileMap,
{
  messages: TMessage[] | null;
  // fileMap?: Record<string, TFile>;
}) {
  if (messages === null) {
    return null;
  }
  return messages.map((m, idx) => ({ ...m, bg: idx % 2 === 0 ? even : odd }));
}
