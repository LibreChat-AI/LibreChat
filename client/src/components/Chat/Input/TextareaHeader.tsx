import { memo } from 'react';
import type { TConversation } from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import AddedConvo from './AddedConvo';

export default memo(function TextareaHeader({
  addedConvo,
  setAddedConvo,
}: {
  addedConvo: TConversation | null;
  setAddedConvo: SetterOrUpdater<TConversation | null>;
}) {
  if (!addedConvo) {
    return null;
  }
  return (
    <div className="m-1.5 flex flex-col divide-y overflow-hidden rounded-b-lg rounded-t-2xl bg-surface-secondary-alt">
      <AddedConvo addedConvo={addedConvo} setAddedConvo={setAddedConvo} />
    </div>
  );
});
