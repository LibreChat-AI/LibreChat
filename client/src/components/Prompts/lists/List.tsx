import { FileText } from 'lucide-react';
import { EmptyState } from '@librechat/client';
import type { TPromptGroup } from 'librechat-data-provider';
import ChatGroupItem from './ChatGroupItem';
import { useLocalize } from '~/hooks';

export default function List({
  groups = [],
  isChatRoute,
}: {
  groups?: TPromptGroup[];
  isChatRoute?: boolean;
}) {
  const localize = useLocalize();

  const renderContent = () => {
    if (groups.length === 0) {
      return (
        <EmptyState
          icon={FileText}
          title={localize('com_ui_no_prompts_title')}
          description={localize('com_ui_add_first_prompt')}
          className="my-2"
        />
      );
    }

    return groups.map((group) => (
      <ChatGroupItem key={group._id} group={group} isChatRoute={isChatRoute} />
    ));
  };

  return (
    <section className="flex-grow" aria-label={localize('com_ui_prompt_groups')}>
      <div>{renderContent()}</div>
    </section>
  );
}
