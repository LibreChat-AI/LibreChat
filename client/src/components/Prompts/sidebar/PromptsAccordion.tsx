import { SystemRoles } from 'librechat-data-provider';
import type { TPromptGroup } from 'librechat-data-provider';
import AutoSendPrompt from '../buttons/AutoSendPrompt';
import { AdminSettings } from '~/components/Prompts';
import PromptSidePanel from './GroupSidePanel';
import { PanelFooter } from '~/components/ui';
import FilterPrompts from './FilterPrompts';
import { useAuthContext } from '~/hooks';

export default function PromptsAccordion({
  visible,
  isChatRoute,
  onUsePrompt,
}: {
  visible?: boolean;
  isChatRoute?: boolean;
  onUsePrompt?: (group: TPromptGroup) => void;
} = {}) {
  const { user } = useAuthContext();
  return (
    <PromptSidePanel
      className="space-y-2 pt-2"
      visible={visible}
      isChatRoute={isChatRoute}
      onUsePrompt={onUsePrompt}
      footer={
        user?.role === SystemRoles.ADMIN ? (
          <PanelFooter>
            <AdminSettings />
          </PanelFooter>
        ) : null
      }
    >
      <FilterPrompts>
        {isChatRoute !== false && <AutoSendPrompt />}
      </FilterPrompts>
    </PromptSidePanel>
  );
}
