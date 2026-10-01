import { useRef, useState, useEffect, useCallback } from 'react';
import { useToastContext } from '@librechat/client';
import { isImportJobStarted } from 'librechat-data-provider';
import type { TImportResponse, TImportPhase } from 'librechat-data-provider';
import {
  useGetStartupConfig,
  useUploadImportMutation,
  useStartImportMutation,
  useCancelImportMutation,
  useImportJobQuery,
  isJobGone,
} from '~/data-provider';
import { readActiveJobId, writeActiveJobId } from './storage';
import { useAuthContext } from '~/hooks/AuthContext';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';
import Dropzone from './Dropzone';
import Progress from './Progress';
import Loading from './Loading';
import Summary from './Summary';
import Lost from './Lost';

const JSON_FILE_TOO_LARGE_MESSAGE =
  'This JSON file is too large to import on its own. Compress it into a .zip and upload that instead';

/** Phases the job will never move out of. Once one is reached the panel has
 * nothing left to rejoin, so the id must stop being remembered. */
const SETTLED_PHASES = new Set<TImportPhase>(['completed', 'failed', 'cancelled']);

function getUploadErrorMessage(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { message?: string } } })?.response?.data;
  return data?.message;
}

function getUploadErrorKey(message: string | undefined) {
  if (message === 'Unsupported import type') {
    return 'com_ui_import_conversation_file_type_error';
  }
  if (message === JSON_FILE_TOO_LARGE_MESSAGE) {
    return 'com_ui_import_conversation_json_too_large';
  }
  return 'com_ui_import_conversation_upload_error';
}

export default function Import() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  /**
   * Seeded from `localStorage` so closing the settings dialog, navigating,
   * or reloading during a multi-minute import rejoins the running job
   * instead of losing its progress, cancel button, and final report; and
   * instead of tempting a second upload, which would duplicate every
   * conversation the first run had not yet committed.
   */
  const [jobId, setJobId] = useState<string | null>(() => readActiveJobId(user?.id));
  const cameFromResetRef = useRef(false);

  const { data: startupConfig } = useGetStartupConfig();
  const { data: job, error: jobError, isError: isJobError } = useImportJobQuery(jobId);

  /**
   * Stop remembering a job the moment it settles, while keeping it in state so
   * the report stays on screen for this mount. Without this the id outlived the
   * import: reopening Settings showed a stale report instead of the import
   * control, and once the 24h server TTL expired the row's resting state became
   * the "job lost" card for every user who had ever run an import.
   * `localStorage` is an external system, so this is a real effect.
   */
  const isSettled = job != null && SETTLED_PHASES.has(job.phase);
  const isGone = isJobError && isJobGone(jobError);
  /**
   * Only a job the server says no longer exists is lost. A transient failure
   * on the way there (a 503, a dropped connection) leaves the import
   * running, so the last status we hold keeps rendering while the query
   * retries; swapping in the "job lost" card there hid a live import behind a
   * dead end. With no status to fall back on there is nothing to show but the
   * card.
   */
  const isLost = isGone || (isJobError && job == null);
  useEffect(() => {
    if (isSettled || isGone) {
      writeActiveJobId(user?.id, null);
    }
  }, [isSettled, isGone, user?.id]);

  const trackJob = useCallback(
    (next: string | null) => {
      writeActiveJobId(user?.id, next);
      setJobId(next);
    },
    [user?.id],
  );

  const uploadMutation = useUploadImportMutation({
    onSuccess: (data: TImportResponse) => {
      if (isImportJobStarted(data)) {
        trackJob(data.jobId);
        return;
      }
      showToast({
        message: localize('com_ui_import_conversation_success'),
        severity: NotificationSeverity.SUCCESS,
      });
    },
    onError: (error: unknown) => {
      const uploadError = getUploadErrorMessage(error);
      showToast({
        message: localize(getUploadErrorKey(uploadError)),
        severity: NotificationSeverity.ERROR,
      });
    },
  });

  const startMutation = useStartImportMutation({
    onError: () => {
      showToast({
        message: localize('com_ui_import_conversation_error'),
        severity: NotificationSeverity.ERROR,
      });
    },
  });

  const cancelMutation = useCancelImportMutation();

  const handleFile = useCallback(
    (file: File) => {
      const maxFileSize = startupConfig?.conversationImportMaxFileSize;
      /** The config route emits the limit the server actually enforces, so this
       * check runs on every deployment. A non-positive value is still treated
       * as "no limit" for an operator who has explicitly disabled the cap. */
      if (maxFileSize != null && maxFileSize > 0 && file.size > maxFileSize) {
        showToast({
          message: localize('com_error_files_upload_too_large', {
            0: (maxFileSize / (1024 * 1024)).toFixed(2),
          }),
          severity: NotificationSeverity.ERROR,
        });
        return;
      }

      const formData = new FormData();
      formData.append('file', file, encodeURIComponent(file.name || 'File'));
      uploadMutation.mutate(formData);
    },
    [localize, showToast, startupConfig, uploadMutation],
  );

  const handleConfirm = useCallback(() => {
    if (jobId != null) {
      startMutation.mutate(jobId);
    }
  }, [jobId, startMutation]);

  const handleCancel = useCallback(() => {
    if (jobId != null) {
      cancelMutation.mutate(jobId);
    }
  }, [jobId, cancelMutation]);

  const handleReset = useCallback(() => {
    cameFromResetRef.current = true;
    trackJob(null);
  }, [trackJob]);

  const showSummary = job?.phase === 'awaiting_confirmation' && job.summary != null;

  return (
    <div className="flex flex-col gap-2">
      {jobId == null && (
        <Dropzone
          onFile={handleFile}
          isUploading={uploadMutation.isLoading}
          focusOnMount={cameFromResetRef.current}
        />
      )}

      {jobId != null && isLost && <Lost onReset={handleReset} />}

      {jobId != null && !isLost && job == null && <Loading />}

      {job != null && !isLost && showSummary && job.summary != null && (
        <Summary
          summary={job.summary}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
          isConfirming={startMutation.isLoading}
          isCancelling={cancelMutation.isLoading}
        />
      )}

      {job != null && !isLost && !showSummary && (
        <Progress
          job={job}
          onCancel={handleCancel}
          onReset={handleReset}
          isCancelling={cancelMutation.isLoading}
        />
      )}
    </div>
  );
}
