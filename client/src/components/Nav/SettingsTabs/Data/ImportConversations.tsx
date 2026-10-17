import { useState, useRef, useCallback } from 'react';
import { Import } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Spinner, useToastContext, Label, Button } from '@librechat/client';
import type { TStartupConfig } from 'librechat-data-provider';
import { startupConfigKey, useUploadConversationsMutation } from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';
import { cn, logger } from '~/utils';

function ImportConversations() {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleSuccess = useCallback(() => {
    showToast({
      message: localize('com_ui_import_conversation_success'),
      status: NotificationSeverity.SUCCESS,
    });
    setIsUploading(false);
  }, [localize, showToast]);

  const handleError = useCallback(
    (error: unknown) => {
      logger.error('Import error:', error);
      setIsUploading(false);

      const isUnsupportedType = error?.toString().includes('Unsupported import type');

      showToast({
        message: localize(
          isUnsupportedType
            ? 'com_ui_import_conversation_file_type_error'
            : 'com_ui_import_conversation_error',
        ),
        status: NotificationSeverity.ERROR,
      });
    },
    [localize, showToast],
  );

  const uploadFile = useUploadConversationsMutation({
    onSuccess: handleSuccess,
    onError: handleError,
    onMutate: () => setIsUploading(true),
  });

  const handleFileUpload = useCallback(
    async (file: File) => {
      try {
        const startupConfig = queryClient.getQueryData<TStartupConfig>(startupConfigKey(true));
        const maxFileSize = startupConfig?.conversationImportMaxFileSize;
        if (maxFileSize && file.size > maxFileSize) {
          const size = (maxFileSize / (1024 * 1024)).toFixed(2);
          showToast({
            message: localize('com_error_files_upload_too_large', { 0: size }),
            status: NotificationSeverity.ERROR,
          });
          setIsUploading(false);
          return;
        }

        const formData = new FormData();
        formData.append('file', file, encodeURIComponent(file.name || 'File'));
        uploadFile.mutate(formData);
      } catch (error) {
        logger.error('File processing error:', error);
        setIsUploading(false);
        showToast({
          message: localize('com_ui_import_conversation_upload_error'),
          status: NotificationSeverity.ERROR,
        });
      }
    },
    [uploadFile, showToast, localize, queryClient],
  );

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        setIsUploading(true);
        handleFileUpload(file);
      }
      event.target.value = '';
    },
    [handleFileUpload],
  );

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleImportClick();
      }
    },
    [handleImportClick],
  );

  const isImportDisabled = isUploading;

  return (
    <div className="flex items-center justify-between">
      <Label id="import-conversation-label">{localize('com_ui_import_conversation_info')}</Label>
      <Button
        variant="outline"
        onClick={handleImportClick}
        onKeyDown={handleKeyDown}
        disabled={isImportDisabled}
        aria-label={localize('com_ui_import')}
        aria-labelledby="import-conversation-label"
      >
        {isUploading ? (
          <>
            <Spinner className="mr-1 w-4" />
            <span>{localize('com_ui_importing')}</span>
          </>
        ) : (
          <>
            <Import className="mr-1 flex h-4 w-4 items-center stroke-1" aria-hidden="true" />
            <span>{localize('com_ui_import')}</span>
          </>
        )}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        className={cn('hidden')}
        accept=".json"
        onChange={handleFileChange}
        aria-hidden="true"
      />
    </div>
  );
}

export default ImportConversations;
