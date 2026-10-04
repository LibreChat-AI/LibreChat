import React, { useState, useMemo } from 'react';
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
import type { TUserMemory } from 'librechat-data-provider';
import { getMemoryKeyError, getMemoryValueError, getMemoryApiErrorMessage } from '~/utils/memory';
import { useUpdateMemoryMutation, useMemoriesQuery } from '~/data-provider';
import { getMemoryAddress, getMemoryUpdateAddress } from './address';
import { useLocalize, useHasAccess, useClockFormat } from '~/hooks';
import MemoryUsageBadge from './MemoryUsageBadge';

interface MemoryEditDialogProps {
  memory: TUserMemory | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  triggerRef?: React.MutableRefObject<HTMLButtonElement | null>;
}

const formatDateTime = (dateString: string, hour12?: boolean): string => {
  return new Date(dateString).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  });
};

export default function MemoryEditDialog({
  memory,
  open,
  onOpenChange,
  children,
  triggerRef,
}: MemoryEditDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: memData } = useMemoriesQuery();
  const hour12 = useClockFormat();

  const hasUpdateAccess = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.UPDATE,
  });

  const { mutate: updateMemory, isLoading } = useUpdateMemoryMutation({
    onSuccess: () => {
      showToast({
        message: localize('com_ui_saved'),
        status: 'success',
      });
      onOpenChange(false);
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
  const [originalKey, setOriginalKey] = useState('');
  const [touched, setTouched] = useState({ key: false, value: false });
  const [prevMemory, setPrevMemory] = useState<TUserMemory | null>(null);
  const memoryAddress = memory ? getMemoryAddress(memory) : null;
  const requiresKey =
    memoryAddress == null || !('id' in memoryAddress) || memory?.key.trim() !== '';

  if (memory !== prevMemory) {
    setPrevMemory(memory);
    if (memory) {
      setKey(memory.key);
      setValue(memory.value);
      setOriginalKey(memory.key);
      setTouched({ key: false, value: false });
    }
  }

  const keyError =
    requiresKey || key.trim() !== ''
      ? getMemoryKeyError({
          key,
          memories: memData?.memories,
          agentId: memory?.agentId,
          originalKey,
        })
      : null;
  const valueError = getMemoryValueError(value);
  const hasErrors = keyError != null || valueError != null;
  /** Stay quiet on a pristine empty field; validate live once there is something to judge. */
  const showKeyError = hasUpdateAccess && (touched.key || key !== '');
  const showValueError = hasUpdateAccess && (touched.value || value !== '');

  const handleSave = () => {
    if (!hasUpdateAccess || !memory || !memoryAddress) {
      return;
    }

    const trimmedKey = key.trim();
    if (keyError || valueError) {
      setTouched({ key: true, value: true });
      return;
    }

    const updateAddress = getMemoryUpdateAddress(memory, trimmedKey);
    if (!updateAddress) {
      return;
    }

    updateMemory({
      ...updateAddress,
      value: value.trim(),
      agentId: memory.agentId,
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey && hasUpdateAccess) {
      handleSave();
    }
  };

  // Calculate memory-specific usage: available = tokenLimit - (totalTokens - thisMemoryTokens)
  const memoryUsage = useMemo(() => {
    if (!memory?.tokenCount || !memData?.tokenLimit) {
      return null;
    }
    const availableForMemory = memData.tokenLimit - (memData.totalTokens ?? 0) + memory.tokenCount;
    const percentage = Math.round((memory.tokenCount / availableForMemory) * 100);
    return { availableForMemory, percentage };
  }, [memory?.tokenCount, memData?.tokenLimit, memData?.totalTokens]);

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      {children}
      <OGDialogTemplate
        title={hasUpdateAccess ? localize('com_ui_edit_memory') : localize('com_ui_view_memory')}
        showCloseButton={false}
        className="w-11/12 md:max-w-2xl"
        main={
          <div className="space-y-4">
            {/* When it last changed, and what it costs. The size is the badge's to
                state when a limit gives it something to be a share of, and a plain
                count otherwise: two slots, so neither is stranded mid-bar. */}
            {memory && (
              <div className="border-border-light bg-surface-secondary flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <span className="text-text-secondary min-w-0 truncate text-xs">
                  {formatDateTime(memory.updated_at, hour12)}
                </span>
                {memoryUsage ? (
                  <MemoryUsageBadge
                    percentage={memoryUsage.percentage}
                    tokenLimit={memData?.tokenLimit ?? 0}
                    tooltipCurrent={memory.tokenCount}
                    tooltipMax={memoryUsage.availableForMemory}
                  />
                ) : (
                  memory.tokenCount !== undefined && (
                    <span className="text-text-secondary shrink-0 text-xs">
                      {memory.tokenCount.toLocaleString()}{' '}
                      {localize(memory.tokenCount === 1 ? 'com_ui_token' : 'com_ui_tokens')}
                    </span>
                  )
                )}
              </div>
            )}

            {/* Key input */}
            <div className="space-y-2">
              <Label htmlFor="memory-key" className="text-text-primary text-sm font-medium">
                {localize('com_ui_key')}
              </Label>
              <Input
                id="memory-key"
                value={key}
                onChange={(e) => hasUpdateAccess && setKey(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, key: true }))}
                onKeyDown={handleKeyPress}
                placeholder={localize('com_ui_enter_key')}
                className="w-full"
                disabled={!hasUpdateAccess}
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

            {/* Value textarea */}
            <div className="space-y-2">
              <Label htmlFor="memory-value" className="text-text-primary text-sm font-medium">
                {localize('com_ui_value')}
              </Label>
              <Textarea
                id="memory-value"
                value={value}
                onChange={(e) => hasUpdateAccess && setValue(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, value: true }))}
                onKeyDown={handleKeyPress}
                placeholder={localize('com_ui_enter_value')}
                className="border-border-light text-text-primary focus-visible:ring-border-heavy max-h-[45vh] min-h-[180px] w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-sm focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50"
                rows={8}
                disabled={!hasUpdateAccess}
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
          hasUpdateAccess ? (
            <Button
              type="button"
              variant="submit"
              onClick={handleSave}
              aria-label={localize('com_ui_save')}
              disabled={isLoading || !memoryAddress || hasErrors}
            >
              {isLoading ? <Spinner className="size-4" /> : localize('com_ui_save')}
            </Button>
          ) : null
        }
      />
    </OGDialog>
  );
}
