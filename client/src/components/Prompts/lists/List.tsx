import { FileText } from 'lucide-react';
import { EmptyState } from '@librechat/client';
import { ResourceType } from 'librechat-data-provider';
import { useGetAllEffectivePermissionsQuery } from 'librechat-data-provider/react-query';
import type { TPromptGroup } from 'librechat-data-provider';
import ChatGroupItem from './ChatGroupItem';
import { useLocalize } from '~/hooks';

export default function List({
  groups = [],
  isChatRoute,
  isFiltered = false,
  onUsePrompt,
}: {
  groups?: TPromptGroup[];
  isChatRoute?: boolean;
  isFiltered?: boolean;
  onUsePrompt?: (group: TPromptGroup) => void;
}) {
  const localize = useLocalize();
  const { data: permissionsMap } = useGetAllEffectivePermissionsQuery(ResourceType.PROMPTGROUP, {
    enabled: groups.length > 0,
  });

  const renderContent = () => {
    if (groups.length === 0) {
      return (
        <EmptyState
          icon={FileText}
          title={localize(isFiltered ? 'com_ui_no_results_found' : 'com_ui_no_prompts_title')}
          description={isFiltered ? undefined : localize('com_ui_add_first_prompt')}
          className="my-2"
        />
      );
    }

    return groups.map((group) => (
      <ChatGroupItem
        key={group._id}
        group={group}
        isChatRoute={isChatRoute}
        onUsePrompt={onUsePrompt}
        permissionBits={group._id ? permissionsMap?.[group._id] : 0}
      />
    ));
  };

  return (
    <section className="grow" aria-label={localize('com_ui_prompt_groups')}>
      <div>{renderContent()}</div>
    </section>
  );
}
