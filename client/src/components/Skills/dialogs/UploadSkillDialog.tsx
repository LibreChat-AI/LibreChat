import { useRef, useCallback, useState } from 'react';
import { Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { OGDialog, OGDialogContent, Spinner, useToastContext } from '@librechat/client';
import {
  megabyte,
  mergeFileConfig,
  fileConfig as defaultFileConfig,
} from 'librechat-data-provider';
import type {
  SkillImportFailureReason,
  TSkillImportFailedFile,
  TSkillImportFailedResponse,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useGetFileConfig, useImportSkillMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface UploadSkillDialogProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

function formatMegabytes(bytes: number): string {
  const value = bytes / megabyte;
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

/** Localization key per failure reason; `limitMb` fills `{{0}}` where present. */
const FAILURE_REASON_KEYS: Record<SkillImportFailureReason, TranslationKeys> = {
  invalid_path: 'com_ui_skill_upload_reason_invalid_path',
  file_too_large: 'com_ui_skill_upload_reason_file_too_large',
  archive_too_large: 'com_ui_skill_upload_reason_archive_too_large',
  archive_entry_changed: 'com_ui_skill_upload_reason_archive_entry_changed',
  persistence_failed: 'com_ui_skill_upload_reason_persistence_failed',
};

type ImportFailure = {
  /** `skill_import_rollback_failed` also means the leftover skill needs deleting. */
  code: TSkillImportFailedResponse['error'];
  files: TSkillImportFailedFile[];
};

/**
 * An import that could not persist every bundled file is rolled back whole and
 * answered with `failedFiles`. Those paths are the only place the user learns
 * which resources their archive lost, so they are rendered in the dialog
 * instead of being flattened into a toast that disappears.
 */
function getImportFailure(error: unknown): ImportFailure | null {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (data == null || typeof data !== 'object') {
    return null;
  }
  const body = data as Partial<TSkillImportFailedResponse>;
  if (
    (body.error !== 'skill_import_incomplete' &&
      body.error !== 'skill_import_rollback_failed' &&
      body.error !== 'skill_import_cleanup_incomplete') ||
    !Array.isArray(body.failedFiles)
  ) {
    return null;
  }
  return { code: body.error, files: body.failedFiles };
}

function failureMessageKey(code: ImportFailure['code']): TranslationKeys {
  if (code === 'skill_import_rollback_failed') {
    return 'com_ui_skill_upload_rollback_failed';
  }
  if (code === 'skill_import_cleanup_incomplete') {
    return 'com_ui_skill_upload_cleanup_incomplete';
  }
  return 'com_ui_skill_upload_incomplete';
}

function failureHeadingKey(code: ImportFailure['code']): TranslationKeys {
  if (code === 'skill_import_rollback_failed') {
    return 'com_ui_skill_upload_rollback_failed_files';
  }
  if (code === 'skill_import_cleanup_incomplete') {
    return 'com_ui_skill_upload_cleanup_incomplete_files';
  }
  return 'com_ui_skill_upload_failed_files';
}

export default function UploadSkillDialog({ isOpen, setIsOpen }: UploadSkillDialogProps) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  /**
   * The dialog outlives any single upload: `CreateSkillMenu` keeps it mounted
   * and only toggles `isOpen`. Closing it mid-import cannot cancel the request,
   * so each session is numbered and a response that resolves after its own
   * session ended is dropped rather than repopulating a dismissed panel.
   */
  const dialogSessionRef = useRef(0);
  const requestSessionRef = useRef(0);
  const {
    data: skillFileConfig = { configuredSizeLimitMb: undefined, fileConfig: defaultFileConfig },
  } = useGetFileConfig({
    select: (data) => ({
      configuredSizeLimitMb: data?.skills?.fileSizeLimit,
      fileConfig: mergeFileConfig(data),
    }),
  });
  const { configuredSizeLimitMb, fileConfig } = skillFileConfig;
  const skillImportSizeLimit =
    fileConfig.skills?.fileSizeLimit ?? defaultFileConfig.skills?.fileSizeLimit ?? 0;
  const displayedSizeLimit =
    configuredSizeLimitMb !== undefined
      ? `${configuredSizeLimitMb}`
      : formatMegabytes(skillImportSizeLimit);

  const importMutation = useImportSkillMutation({
    onSuccess: (skill) => {
      if (requestSessionRef.current !== dialogSessionRef.current) {
        return;
      }
      setFailure(null);
      showToast({ status: 'success', message: localize('com_ui_skill_created') });
      setIsOpen(false);
      navigate(`/skills/${skill._id}`);
    },
    onError: (error: unknown) => {
      if (requestSessionRef.current !== dialogSessionRef.current) {
        return;
      }
      const importFailure = getImportFailure(error);
      if (importFailure != null) {
        /** Keep the dialog open: the archive has to be fixed before a retry can
         *  succeed, and the failed paths are only listed here. */
        setFailure(importFailure);
        showToast({
          status: 'error',
          message: localize(failureMessageKey(importFailure.code), {
            0: `${importFailure.files.length}`,
          }),
        });
        return;
      }
      const errData = (error as { response?: { data?: { error?: string; message?: string } } })
        ?.response?.data;
      const message =
        errData?.message ?? errData?.error ?? localize('com_ui_create_skill_upload_error');
      setFailure(null);
      showToast({ status: 'error', message });
    },
  });

  const handleFile = useCallback(
    (file: File) => {
      if (importMutation.isLoading) {
        return;
      }
      setFailure(null);
      if (file.size > skillImportSizeLimit) {
        showToast({
          status: 'error',
          message: localize('com_ui_skill_upload_size_error', { 0: displayedSizeLimit }),
        });
        return;
      }
      const formData = new FormData();
      formData.append('file', file, file.name);
      requestSessionRef.current = dialogSessionRef.current;
      importMutation.mutate(formData);
    },
    [displayedSizeLimit, importMutation, localize, showToast, skillImportSizeLimit],
  );

  const handleFileInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        handleFile(file);
      }
      event.target.value = '';
    },
    [handleFile],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        handleFile(file);
      }
    },
    [handleFile],
  );

  return (
    <OGDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          dialogSessionRef.current += 1;
          setFailure(null);
        }
        setIsOpen(open);
      }}
    >
      <OGDialogContent className="w-11/12 max-w-lg overflow-hidden">
        <div className="flex flex-col gap-6 p-1 sm:p-2">
          <h2 className="text-lg font-bold text-text-primary">
            {localize('com_ui_skill_upload_title')}
          </h2>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              disabled={importMutation.isLoading}
              className={cn(
                'flex h-[120px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-text-secondary transition-colors',
                isDragging
                  ? 'border-border-heavy bg-surface-hover'
                  : 'border-border-medium hover:bg-surface-hover',
                importMutation.isLoading && 'cursor-wait opacity-50',
              )}
            >
              {importMutation.isLoading ? (
                <Spinner className="size-8" />
              ) : (
                <Upload className="size-8 text-text-secondary" aria-hidden="true" />
              )}
              {localize('com_ui_skill_upload_drag')}
            </button>

            {failure != null && failure.files.length > 0 && (
              <div
                role="alert"
                className="flex flex-col gap-1 rounded-lg border border-border-medium bg-surface-secondary p-3 text-xs"
              >
                <p className="font-medium text-text-destructive">
                  {localize(failureHeadingKey(failure.code))}
                </p>
                {/* An archive may hold up to 500 entries, and the dialog's own
                    overflow-hidden would clip a long list past the viewport. */}
                <ul className="max-h-40 list-inside list-disc overflow-y-auto text-text-secondary">
                  {failure.files.map((failedFile) => (
                    <li key={failedFile.path}>
                      <span className="break-all font-medium text-text-primary">
                        {failedFile.path}
                      </span>
                      {FAILURE_REASON_KEYS[failedFile.reason] != null
                        ? ` — ${localize(FAILURE_REASON_KEYS[failedFile.reason], {
                            0: `${failedFile.limitMb ?? ''}`,
                          })}`
                        : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-col gap-3 text-xs text-text-secondary">
              <div>
                <p className="font-medium">{localize('com_ui_skill_upload_requirements')}</p>
                <ul className="mt-1 list-inside list-disc">
                  <li>{localize('com_ui_skill_upload_req_md')}</li>
                  <li>{localize('com_ui_skill_upload_req_zip')}</li>
                  <li>{localize('com_ui_skill_upload_req_size', { 0: displayedSizeLimit })}</li>
                </ul>
              </div>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.skill,.md"
            className="hidden"
            onChange={handleFileInput}
          />
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
