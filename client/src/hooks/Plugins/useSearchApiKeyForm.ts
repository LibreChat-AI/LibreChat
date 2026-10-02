import { useRef, useMemo, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import type { SearchApiKeyFormData } from '~/hooks/Plugins/useAuthSearchTool';
import useAuthSearchTool from '~/hooks/Plugins/useAuthSearchTool';

export default function useSearchApiKeyForm({
  onSubmit,
  onRevoke,
}: {
  onSubmit?: () => void;
  onRevoke?: () => void;
}) {
  const methods = useForm<SearchApiKeyFormData>();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const badgeTriggerRef = useRef<HTMLInputElement>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { installTool, removeTool } = useAuthSearchTool({ isEntityTool: true });
  const {
    reset,
    formState: { dirtyFields },
  } = methods;

  const onSubmitHandler = useCallback(
    (data: SearchApiKeyFormData) => {
      installTool(data, dirtyFields);
      setIsDialogOpen(false);
      onSubmit?.();
    },
    [dirtyFields, onSubmit, installTool],
  );

  const handleRevokeApiKey = useCallback(() => {
    reset();
    removeTool();
    setIsDialogOpen(false);
    onRevoke?.();
  }, [reset, onRevoke, removeTool]);

  /* Memoized because `BadgeRowProvider` carries this straight into its context
     value: a fresh object here changed that value on every keystroke in the
     composer, which is the one thing the provider's own memo exists to stop. */
  return useMemo(
    () => ({
      methods,
      isDialogOpen,
      setIsDialogOpen,
      handleRevokeApiKey,
      onSubmit: onSubmitHandler,
      badgeTriggerRef,
      menuTriggerRef,
    }),
    [methods, isDialogOpen, handleRevokeApiKey, onSubmitHandler],
  );
}
