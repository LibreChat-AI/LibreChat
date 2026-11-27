import type { ParallelColumnHeaderProps } from '@librechat/chat/components';
import SiblingHeader from './SiblingHeader';

export { ParallelColumns, ParallelContentRenderer } from '@librechat/chat/components';
export { groupParallelContent, lastParallelColumnCursorIdx } from '@librechat/chat';
export type { PartWithIndex, ParallelColumn, ParallelSection } from '@librechat/chat';

/** The header of one parallel column: this app's sibling header, with its branch action. */
export const renderSiblingHeader = (props: ParallelColumnHeaderProps) => (
  <SiblingHeader {...props} />
);
