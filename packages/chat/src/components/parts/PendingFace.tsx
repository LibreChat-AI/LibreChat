import type { ReactNode } from 'react';

/**
 * The face a subagent wears before anyone knows who it is: an empty, dashed circle that fills its
 * slot, so the agent's own avatar can take the same place without moving anything once it is
 * known.
 */
export default function PendingFace(): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-subagent-pending-face
      className="border-border-heavy bg-surface-tertiary block size-full rounded-full border border-dashed"
    />
  );
}
