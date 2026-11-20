import { useId } from 'react';
import { cn, Spinner } from '@librechat/client';
import { MAX_FILE_TEXT_PREVIEW_LENGTH } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { ExtendedFile } from '../../../core/files';
import FilePreview from './FilePreview';
import { getFileType } from './kinds';
import RemoveFile from './RemoveFile';

/** A second action offered in place of the subtitle, stated on the chip rather than revealed on hover. */
export type SubtitleAction = {
  label: string;
  onClick: () => void;
};

const FileContainer = ({
  file,
  overrideType,
  displayName,
  textPreview,
  subtitle,
  subtitleAction,
  ariaLabel,
  buttonClassName,
  containerClassName,
  onDelete,
  removeLabel,
  removeDisabled,
  onClick,
}: {
  file: Partial<ExtendedFile | TFile>;
  overrideType?: string;
  /**
   * Optional pre-computed label for the chip. Callers in code-execution
   * artifact contexts pass the de-suffixed name; upload chips and
   * persisted user files leave this undefined and render the raw filename.
   */
  displayName?: string;
  /** Plain-text snippet; defaults to stored text/plain content. Null disables the preview. */
  textPreview?: string | null;
  /**
   * Optional override for the subtitle line (defaults to the file
   * type's localized title — e.g. "PowerPoint Presentation"). Used by
   * the deferred-preview flow to surface "Preparing preview…" /
   * "Preview unavailable" inline within the chip rather than as a
   * loose-feeling annotation below it. Pass a ReactNode so callers
   * can include icons (spinner, alert) alongside the text.
   */
  subtitle?: ReactNode;
  /**
   * Turns the subtitle line into its own control, so a chip can offer a second action without
   * spending another visible affordance on it. Supplying this drops the chip's own `<button>`
   * wrapper for a full-bleed one sitting behind the content, because a button inside a button
   * is invalid markup and browsers drop the inner one's events.
   */
  subtitleAction?: SubtitleAction;
  /**
   * Overrides the chip's accessible name. Callers that make the chip do something
   * (open an editor, open a preview) pass a label that says so, since the bare
   * filename does not tell a screen reader user that the chip is actionable.
   */
  ariaLabel?: string;
  buttonClassName?: string;
  containerClassName?: string;
  onDelete?: () => void;
  /** Accessible name for the remove control; defaults to a generic "Remove file". */
  removeLabel?: string;
  removeDisabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}): React.JSX.Element => {
  const fileType = getFileType(overrideType ?? file.type);
  const visibleName = displayName ?? file.filename ?? '';
  const previewId = useId();
  let previewText = textPreview;
  if (
    previewText === undefined &&
    file.type === 'text/plain' &&
    !('textFormat' in file && file.textFormat === 'html')
  ) {
    previewText = file.textPreview ?? file.text;
  }
  const snippet = previewText?.trim().slice(0, MAX_FILE_TEXT_PREVIEW_LENGTH);
  const hasTextPreview = snippet != null && snippet !== '';
  const isUploading = 'progress' in file && typeof file.progress === 'number' && file.progress < 1;
  const interactive = onClick != null;
  const surfaceClassName = cn(
    'relative overflow-hidden rounded-2xl border border-border-light bg-surface-hover-alt',
    interactive && 'transition-colors hover:bg-surface-active',
    buttonClassName,
  );
  const focusRing =
    'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface-primary';
  /** The full-bleed target sits inside the surface's `overflow-hidden`, so an offset ring
   * would be clipped away entirely; the inset ring draws within the target's own box and the
   * matching radius keeps it inside the surface's rounded corners. */
  const insetFocusRing =
    'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary';

  const subtitleContent =
    subtitleAction != null ? (
      <button
        type="button"
        onClick={subtitleAction.onClick}
        className={cn(
          'text-text-secondary hover:text-text-primary focus-visible:text-text-primary pointer-events-auto relative z-10 inline-block max-w-full shrink-0 truncate rounded text-start align-middle leading-4 underline underline-offset-2',
          focusRing,
        )}
      >
        {subtitleAction.label}
      </button>
    ) : (
      (subtitle ??
      (!hasTextPreview && (
        <div className="text-text-secondary truncate" title={fileType.title}>
          {fileType.title}
        </div>
      )))
    );

  const name = (
    <div
      dir="auto"
      className={cn('truncate', hasTextPreview ? 'min-w-0 flex-1 text-start' : 'font-medium')}
      title={visibleName}
    >
      {visibleName}
    </div>
  );

  const details = hasTextPreview ? (
    <div className="w-64 max-w-full p-2.5 text-start">
      <div
        id={previewId}
        dir="auto"
        className="line-clamp-2 min-h-8 text-xs leading-4 break-words whitespace-pre-wrap"
        title={snippet}
      >
        {snippet}
      </div>
      <div className="text-text-secondary mt-1 flex min-w-0 items-center gap-2 text-xs">
        {isUploading && <Spinner className="size-3 shrink-0" />}
        {name}
        {subtitleContent}
      </div>
    </div>
  ) : (
    <div className="w-56 max-w-full p-1.5">
      <div className="flex flex-row items-center gap-2">
        <FilePreview file={file} fileType={fileType} className="relative" />
        <div className="overflow-hidden">
          {name}
          {subtitleContent}
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={cn('group text-text-primary relative inline-block text-sm', containerClassName)}
      aria-busy={hasTextPreview && isUploading ? true : undefined}
    >
      {subtitleAction != null ? (
        <div className={surfaceClassName}>
          <button
            type="button"
            onClick={onClick}
            aria-label={ariaLabel ?? visibleName}
            aria-describedby={hasTextPreview ? previewId : undefined}
            className={cn(
              'absolute inset-0 z-0 rounded-2xl',
              interactive && 'cursor-pointer',
              insetFocusRing,
            )}
          />
          <div className="pointer-events-none relative">{details}</div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel ?? visibleName}
          aria-describedby={hasTextPreview ? previewId : undefined}
          className={cn(surfaceClassName, interactive && cn('cursor-pointer', focusRing))}
        >
          {details}
        </button>
      )}
      {onDelete && <RemoveFile onRemove={onDelete} label={removeLabel} disabled={removeDisabled} />}
    </div>
  );
};

export default FileContainer;
