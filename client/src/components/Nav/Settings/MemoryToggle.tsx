import { useState, useEffect } from 'react';
import { Switch, useToastContext } from '@librechat/client';
import { useGetUserQuery, useUpdateMemoryPreferencesMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function MemoryToggle() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: user } = useGetUserQuery();
  const [referenceSavedMemories, setReferenceSavedMemories] = useState(true);

  const mutation = useUpdateMemoryPreferencesMutation({
    onSuccess: () =>
      showToast({ message: localize('com_ui_preferences_updated'), status: 'success' }),
    onError: () => {
      showToast({ message: localize('com_ui_error_updating_preferences'), status: 'error' });
      setReferenceSavedMemories((prev) => !prev);
    },
  });

  useEffect(() => {
    if (user?.personalization?.memories !== undefined) {
      setReferenceSavedMemories(user.personalization.memories);
    }
  }, [user?.personalization?.memories]);

  const onToggle = (checked: boolean) => {
    setReferenceSavedMemories(checked);
    mutation.mutate({ memories: checked });
  };

  return (
    <div className="flex items-center justify-between">
      <div>
        <div id="reference-saved-memories-label">{localize('com_ui_reference_saved_memories')}</div>
        <div id="reference-saved-memories-description" className="mt-1 text-xs text-text-secondary">
          {localize('com_ui_reference_saved_memories_description')}
        </div>
      </div>
      <Switch
        checked={referenceSavedMemories}
        onCheckedChange={onToggle}
        disabled={mutation.isLoading}
        aria-labelledby="reference-saved-memories-label"
        aria-describedby="reference-saved-memories-description"
      />
    </div>
  );
}
