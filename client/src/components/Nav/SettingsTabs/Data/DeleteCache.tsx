import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  OGDialogTemplate,
  Label,
  Button,
  OGDialog,
  OGDialogTrigger,
  Spinner,
  InfoHoverCard,
  useOnClickOutside,
} from '@librechat/client';
import { useLocalize } from '~/hooks';
import { ESide } from '~/common';

export const DeleteCache = ({ disabled = false }: { disabled?: boolean }) => {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const [isCacheEmpty, setIsCacheEmpty] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const contentRef = useRef(null);
  useOnClickOutside(contentRef, () => confirmClear && setConfirmClear(false), []);

  const checkCache = useCallback(async () => {
    const cache = await caches.open('tts-responses');
    const keys = await cache.keys();
    setIsCacheEmpty(keys.length === 0);
  }, []);

  useEffect(() => {
    checkCache();
  }, [checkCache]);

  const revokeAllUserKeys = useCallback(async () => {
    setIsLoading(true);
    const cache = await caches.open('tts-responses');
    await cache.keys().then((keys) => Promise.all(keys.map((key) => cache.delete(key))));
    setIsLoading(false);
  }, []);

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <Label id="delete-cache-label">{localize('com_nav_delete_cache_storage')}</Label>
        <InfoHoverCard side={ESide.Top} text={localize('com_nav_delete_cache_storage_info')} />
      </div>
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button
            variant="destructive"
            onClick={() => setOpen(true)}
            disabled={disabled || isCacheEmpty}
            aria-labelledby="delete-cache-label"
          >
            {localize('com_ui_delete')}
          </Button>
        </OGDialogTrigger>
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_nav_confirm_clear')}
          className="max-w-[450px]"
          main={
            <Label className="text-left text-sm font-medium">
              {localize('com_nav_clear_cache_confirm_message')}
            </Label>
          }
          selection={{
            selectHandler: revokeAllUserKeys,
            selectClasses:
              'bg-surface-destructive text-text-on-status transition-all duration-200 hover:bg-surface-destructive-hover',
            selectText: isLoading ? <Spinner /> : localize('com_ui_delete'),
          }}
        />
      </OGDialog>
    </div>
  );
};
