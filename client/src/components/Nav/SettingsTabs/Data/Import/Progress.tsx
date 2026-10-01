import { Button, Spinner } from '@librechat/client';
import type {
  TImportErrorCode,
  TImportPhase,
  TImportError,
  TImportJob,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import useAutoFocus from './useAutoFocus';
import { useLocalize } from '~/hooks';

const TERMINAL_PHASES = new Set<TImportPhase>(['completed', 'failed', 'cancelled']);

const PHASE_LABEL_KEYS: Partial<Record<TImportPhase, TranslationKeys>> = {
  conversations: 'com_ui_import_phase_conversations',
  assets: 'com_ui_import_phase_assets',
};

const IMPORT_ERROR_KEYS: Record<string, TranslationKeys> = {
  'Unsupported import type': 'com_ui_import_conversation_file_type_error',
  'The uploaded archive exceeds the allowed size limits':
    'com_ui_import_conversation_archive_too_large',
  'This JSON file is too large to import on its own. Compress it into a .zip and upload that instead':
    'com_ui_import_conversation_json_too_large',
  'The uploaded archive is corrupt or could not be read':
    'com_ui_import_conversation_archive_corrupt',
  'A storage error occurred while processing the import':
    'com_ui_import_conversation_storage_error',
  'The import could not be completed': 'com_ui_import_conversation_failed',
};

const IMPORT_REPORT_ERROR_KEYS: Record<TImportErrorCode, TranslationKeys> = {
  unsupported_type: 'com_ui_import_error_unsupported_type',
  archive_too_large: 'com_ui_import_error_archive_too_large',
  file_too_large: 'com_ui_import_error_file_too_large',
  archive_corrupt: 'com_ui_import_error_archive_corrupt',
  storage_error: 'com_ui_import_error_storage_error',
  failed: 'com_ui_import_error_failed',
  shard_not_array: 'com_ui_import_error_shard_not_array',
  shard_wrong_shape: 'com_ui_import_error_shard_wrong_shape',
  shard_missing: 'com_ui_import_error_shard_missing',
  record_malformed: 'com_ui_import_error_record_malformed',
  asset_pointer_invalid: 'com_ui_import_error_asset_pointer_invalid',
  errors_truncated: 'com_ui_import_error_truncated',
};

/** The report keeps the first hundred failures and folds the rest into one
 * trailing `errors_truncated` entry whose count is the number it omits, so the
 * array length is not the number of failures. */
function countFailures(errors: TImportError[]): number {
  return errors.reduce(
    (total, error) =>
      total + (error.code === 'errors_truncated' ? Number(error.params?.count ?? 0) : 1),
    0,
  );
}

interface ProgressProps {
  job: TImportJob;
  onCancel: () => void;
  onReset: () => void;
  isCancelling: boolean;
}

export default function Progress({ job, onCancel, onReset, isCancelling }: ProgressProps) {
  const localize = useLocalize();
  const isTerminal = TERMINAL_PHASES.has(job.phase);
  const { done, total } = job.phase === 'assets' ? job.progress.assets : job.progress.conversations;
  const phaseLabel = localize(PHASE_LABEL_KEYS[job.phase] ?? 'com_ui_importing');
  const statusRef = useAutoFocus<HTMLDivElement, TImportPhase>(job.phase);

  let statusHeading = phaseLabel;
  if (job.phase === 'cancelled') {
    statusHeading = localize('com_ui_import_cancelled');
  } else if (job.phase === 'failed') {
    statusHeading = localize('com_ui_import_conversation_error');
  } else if (job.phase === 'completed') {
    statusHeading = localize('com_ui_import_conversation_success');
  }

  return (
    <section className="flex flex-col gap-3">
      {/* The live region carries the phase heading and the final outcome, and
          deliberately not the counter. `role="status"` is implicitly
          `aria-atomic`, so everything inside it is re-announced in full on
          every change, and the counter moves every two seconds for the length
          of a multi-minute import, which would flood the polite queue and
          starve every other announcement in the app. The numbers stay
          available on demand through the progress bar's `aria-valuetext`.
          What is left announces a handful of times per run: once per phase,
          once for the result. */}
      <div className="flex items-baseline justify-between gap-3">
        <div
          ref={statusRef}
          tabIndex={-1}
          role="status"
          className="text-text-primary flex min-w-0 flex-col gap-1 text-sm focus:outline-none"
        >
          <p className="font-medium">{statusHeading}</p>

          {isTerminal && job.phase === 'failed' && job.error != null && (
            <p className="text-text-destructive">
              {localize(IMPORT_ERROR_KEYS[job.error] ?? 'com_ui_import_conversation_error')}
            </p>
          )}

          {isTerminal && job.report && (
            <>
              <p className="text-text-secondary">
                {localize('com_ui_import_report', {
                  0: job.report.imported,
                  1: job.report.skipped,
                })}
              </p>
              <p className="text-text-secondary">
                {localize('com_ui_import_report_assets', {
                  0: job.report.assetsImported,
                  1: job.report.assetsUnavailable,
                })}
              </p>
            </>
          )}
        </div>

        {!isTerminal && total > 0 && (
          <p aria-hidden="true" className="text-text-secondary shrink-0 text-sm tabular-nums">
            {done} / {total}
          </p>
        )}
      </div>

      {/* Cancel sits inline with the bar rather than on its own row: the phase
          name above already says what is running, so a spinner would be a
          second indicator for one operation and a third row wastes height. */}
      {!isTerminal && (
        <div className="flex items-center gap-3">
          <Button variant="outline" className="shrink-0" onClick={onCancel} disabled={isCancelling}>
            {isCancelling && <Spinner className="mr-1 size-4" aria-hidden="true" />}
            {localize('com_ui_import_cancel')}
          </Button>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total > 0 ? total : undefined}
            aria-valuenow={total > 0 ? done : undefined}
            aria-valuetext={
              total > 0 ? localize('com_ui_import_progress_of', { 0: done, 1: total }) : undefined
            }
            aria-label={phaseLabel}
            className="bg-surface-tertiary h-1.5 min-w-0 flex-1 overflow-hidden rounded-full"
          >
            {total > 0 && (
              <div
                className="bg-text-primary h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.min((done / total) * 100, 100)}%` }}
              />
            )}
          </div>
        </div>
      )}

      {isTerminal && job.report && job.report.errors.length > 0 && (
        <details>
          <summary className="text-text-secondary cursor-pointer text-sm">
            {localize('com_ui_import_errors', { 0: countFailures(job.report.errors) })}
          </summary>
          <ul className="text-text-secondary mt-2 list-inside list-disc text-sm">
            {job.report.errors.map((error, index) => {
              const reasonKey =
                IMPORT_REPORT_ERROR_KEYS[error.code] ?? 'com_ui_import_error_failed';
              const reason = localize(
                reasonKey,
                error.code === 'errors_truncated' ? { 0: error.params?.count ?? 0 } : error.params,
              );
              return (
                <li key={index}>
                  {error.location
                    ? localize('com_ui_import_error_at', { 0: error.location, 1: reason })
                    : reason}
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {isTerminal && (
        <div className="flex justify-start">
          <Button variant="submit" onClick={onReset}>
            {localize('com_ui_import_another')}
          </Button>
        </div>
      )}
    </section>
  );
}
