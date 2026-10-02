import React, { useState } from 'react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  OGDialog,
  OGDialogTemplate,
  Button,
  FieldMessage,
  Label,
  Input,
  Spinner,
  Textarea,
  useToastContext,
} from '@librechat/client';
import { getMemoryKeyError, getMemoryValueError, getMemoryApiErrorMessage } from '~/utils/memory';
import { useCreateMemoryMutation, useMemoriesQuery } from '~/data-provider';
import { useLocalize, useHasAccess } from '~/hooks';

interface MemoryCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  triggerRef?: React.MutableRefObject<HTMLButtonElement | null>;
}

export default function MemoryCreateDialog({
  open,
  onOpenChange,
  children,
  triggerRef,
}: MemoryCreateDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.CREATE,
  });

  const { data: memData } = useMemoriesQuery();

  const { mutate: createMemory, isLoading } = useCreateMemoryMutation({
    onSuccess: () => {
      showToast({
        message: localize('com_ui_memory_created'),
        status: 'success',
      });
      onOpenChange(false);
      setKey('');
      setValue('');
      setTouched({ key: false, value: false });
      setTimeout(() => {
        triggerRef?.current?.focus();
      }, 0);
    },
    onError: (error: Error) => {
      showToast({
        message: getMemoryApiErrorMessage(error, localize('com_ui_error')),
        status: 'error',
      });
    },
  });

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState({ key: false, value: false });
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setKey('');
      setValue('');
      setTouched({ key: false, value: false });
    }
  }

  const keyError = getMemoryKeyError({ key, memories: memData?.memories });
  const valueError = getMemoryValueError(value);
  const hasErrors = keyError != null || valueError != null;
  /** Stay quiet on a pristine empty field; validate live once there is something to judge. */
  const showKeyError = touched.key || key !== '';
  const showValueError = touched.value || value !== '';

  const handleSave = () => {
    if (!hasCreateAccess) {
      return;
    }

    if (keyError || valueError) {
      setTouched({ key: true, value: true });
      return;
    }

    createMemory({
      key: key.trim(),
      value: value.trim(),
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey && hasCreateAccess) {
      handleSave();
    }
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      {children}
      <OGDialogTemplate
        title={localize('com_ui_create_memory')}
        showCloseButton={false}
        className="w-11/12 md:max-w-2xl"
        main={
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="memory-key" className="text-text-primary text-sm font-medium">
                {localize('com_ui_key')}
              </Label>
              <Input
                id="memory-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, key: true }))}
                onKeyDown={handleKeyPress}
                placeholder={localize('com_ui_enter_key')}
                className="w-full"
                aria-invalid={showKeyError && keyError != null}
                aria-describedby="memory-key-message"
              />
              <FieldMessage
                id="memory-key-message"
                message={showKeyError && keyError ? localize(keyError) : null}
                hint={localize('com_ui_memory_key_hint')}
                lines={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="memory-value" className="text-text-primary text-sm font-medium">
                {localize('com_ui_value')}
              </Label>
              <Textarea
                id="memory-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, value: true }))}
                onKeyDown={handleKeyPress}
                placeholder={localize('com_ui_enter_value')}
                className="border-border-light text-text-primary focus-visible:ring-border-heavy max-h-[45vh] min-h-[180px] w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-sm focus-visible:ring-1"
                rows={8}
                aria-invalid={showValueError && valueError != null}
                aria-describedby="memory-value-message"
              />
              <FieldMessage
                id="memory-value-message"
                message={showValueError && valueError ? localize(valueError) : null}
              />
            </div>
          </div>
        }
        buttons={
          <Button
            type="button"
            variant="submit"
            onClick={handleSave}
            disabled={isLoading || hasErrors}
            aria-label={localize('com_ui_create_memory')}
          >
            {isLoading ? <Spinner className="size-4" /> : localize('com_ui_create')}
          </Button>
        }
      />
    </OGDialog>
  );
}
