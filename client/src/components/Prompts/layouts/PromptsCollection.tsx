import type { TPromptGroup } from 'librechat-data-provider';
import GroupSidePanel from '../sidebar/GroupSidePanel';
import FilterPrompts from '../sidebar/FilterPrompts';

export default function PromptsCollection({
  onUsePrompt,
  visible = true,
}: {
  onUsePrompt?: (group: TPromptGroup) => void;
  visible?: boolean;
}) {
  return (
    <GroupSidePanel visible={visible} isChatRoute={false} onUsePrompt={onUsePrompt}>
      <FilterPrompts />
    </GroupSidePanel>
  );
}
