import { memo } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Button,
  OGDialog,
  TooltipAnchor,
  OGDialogTrigger,
  OGDialogTemplate,
  useToastContext,
} from '@librechat/client';
import { useDeleteSkillMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

// Memoed because it renders inside `SkillForm`'s header, which re-renders on
// every keystroke via react-hook-form state updates. Props (`skillId`,
// `skillName`) are stable strings, so the memo skips all of those re-renders.

interface DeleteSkillProps {
  skillId: string;
  skillName: string;
  disabled?: boolean;
  onDelete?: () => void;
}

function DeleteSkill({ skillId, skillName, disabled, onDelete }: DeleteSkillProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const deleteSkill = useDeleteSkillMutation({
    onSuccess: (response) => {
      const cleanupComplete = response.cleanupComplete !== false;
      showToast({
        status: cleanupComplete ? 'success' : 'error',
        message: localize(cleanupComplete ? 'com_ui_skill_deleted' : 'com_ui_skill_delete_partial'),
      });
      onDelete?.();
    },
    onError: () => {
      showToast({ status: 'error', message: localize('com_ui_skill_delete_error') });
    },
  });

  /**
   * No `useCallback` here — `deleteSkill` is a new object on every render
   * (React Query mutation results are unstable references), so the dependency
   * array would invalidate every render and the memoized callback would be
   * recreated anyway, adding overhead for no benefit.
   */
  const handleDelete = () => {
    if (deleteSkill.isLoading) {
      return;
    }
    deleteSkill.mutate({ id: skillId });
  };

  const triggerDisabled = disabled || deleteSkill.isLoading;

  return (
    <OGDialog>
      <OGDialogTrigger asChild>
        <TooltipAnchor
          description={localize('com_ui_delete')}
          side="bottom"
          render={
            <Button
              variant="destructive"
              size="icon"
              className="size-9"
              aria-label={localize('com_ui_delete')}
              disabled={triggerDisabled}
              onClick={(e) => e.stopPropagation()}
            >
              <Trash2 className="size-5" aria-hidden="true" />
            </Button>
          }
        />
      </OGDialogTrigger>
      <OGDialogTemplate
        showCloseButton={false}
        title={localize('com_ui_delete')}
        className="max-w-[450px]"
        main={
          <p className="text-left text-sm text-text-primary">
            {localize('com_ui_skill_delete_confirm', { 0: skillName })}
          </p>
        }
        selection={{
          selectHandler: handleDelete,
          selectClasses:
            'bg-surface-destructive hover:bg-surface-destructive-hover transition-colors duration-200 text-text-on-status',
          selectText: localize('com_ui_delete'),
        }}
      />
    </OGDialog>
  );
}

export default memo(DeleteSkill);
