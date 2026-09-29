import { memo, useCallback } from 'react';
import { ScrollText, X } from 'lucide-react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { useLocalize } from '~/hooks';
import store from '~/store';

/**
 * Chip row rendered above the textarea showing skills the user picked in
 * the `$` popover for the next submission. Each chip has an × button to
 * remove that skill before sending — primary purpose is new-chat UX where
 * there's no submitted user message yet to render `SkillPills` on.
 *
 * Reads + writes `pendingManualSkillsByConvoId` atom directly. The atom
 * gets drained in `useChatFunctions.ask` on submit, so chips naturally
 * disappear once the message is sent.
 */
function PendingManualSkillsChips({ conversationId }: { conversationId: string }) {
  const localize = useLocalize();
  const skills = useRecoilValue(store.pendingManualSkillsByConvoId(conversationId));
  const setSkills = useSetRecoilState(store.pendingManualSkillsByConvoId(conversationId));

  const remove = useCallback(
    (name: string) => {
      setSkills((prev) => prev.filter((s) => s !== name));
    },
    [setSkills],
  );

  if (skills.length === 0) {
    return null;
  }

  return (
    <div
      className="flex flex-wrap gap-1.5 px-2 pt-2"
      role="list"
      aria-label={localize('com_ui_skills_queued')}
    >
      {skills.map((name) => (
        <span
          key={name}
          role="listitem"
          className="inline-flex items-center gap-1 rounded-full border border-border-light bg-surface-secondary px-2 py-0.5 text-xs text-text-secondary"
        >
          <ScrollText className="h-3 w-3 text-status-info" aria-hidden="true" />
          <span className="max-w-[12rem] truncate">{name}</span>
          <button
            type="button"
            aria-label={localize('com_ui_remove_skill_var', { 0: name })}
            onClick={() => remove(name)}
            className="-mr-0.5 ml-0.5 rounded-full p-0.5 text-text-secondary hover:bg-surface-tertiary hover:text-text-primary"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}

export default memo(PendingManualSkillsChips);
