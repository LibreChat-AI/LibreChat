import type { TFile } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { ExtendedFile } from '~/common';
import { getFileType, cn } from '~/utils';
import FilePreview from './FilePreview';
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
  subtitle,
  subtitleAction,
  ariaLabel,
  buttonClassName,
  containerClassName,
  onDelete,
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
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}) => {
  const fileType = getFileType(overrideType ?? file.type);
  const visibleName = displayName ?? file.filename ?? '';
  const interactive = onClick != null;
  const surfaceClassName = cn(
    'relative overflow-hidden rounded-2xl border border-border-light bg-surface-hover-alt',
    interactive && 'transition-colors hover:bg-surface-active',
    buttonClassName,
  );
  const focusRing =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface-primary';
  /** The full-bleed target sits inside the surface's `overflow-hidden`, so an offset ring
   * would be clipped away entirely; the inset ring draws within the target's own box and the
   * matching radius keeps it inside the surface's rounded corners. */
  const insetFocusRing =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary';

  const details = (
    <div className="w-56 p-1.5">
      <div className="flex flex-row items-center gap-2">
        <FilePreview file={file} fileType={fileType} className="relative" />
        <div className="overflow-hidden">
          <div className="truncate font-medium" title={visibleName}>
            {visibleName}
          </div>
          {subtitleAction != null ? (
            /** Sits above the full-bleed target so the subtitle keeps its own click. */
            <button
              type="button"
              onClick={subtitleAction.onClick}
              className={cn(
                /** The chip's only cue that its text can be brought back, so it states itself
                 * at rest instead of replacing the file type on hover: an affordance that only
                 * appears under a pointer is one most people never find, and touch has no
                 * pointer to find it with. Underlined for the same reason — as a permanent
                 * subtitle it would otherwise read as a description rather than a control. The
                 * hit area is the label and nothing more: `inline-block` keeps it off the rest
                 * of the row, and `leading-4` keeps it inside its 20px line so the chip's own
                 * center still opens the editor. The colour shift answers focus as well as
                 * hover: the ring already announces focus, but leaving the two input modes
                 * with different feedback is a difference with no reason behind it. */
                'pointer-events-auto relative z-10 inline-block max-w-full truncate rounded text-left align-middle leading-4 text-text-secondary underline underline-offset-2 hover:text-text-primary focus-visible:text-text-primary',
                focusRing,
              )}
            >
              {subtitleAction.label}
            </button>
          ) : (
            (subtitle ?? (
              <div className="truncate text-text-secondary" title={fileType.title}>
                {fileType.title}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={cn('group relative inline-block text-sm text-text-primary', containerClassName)}
    >
      {subtitleAction != null ? (
        <div className={surfaceClassName}>
          <button
            type="button"
            onClick={onClick}
            aria-label={ariaLabel ?? visibleName}
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
          className={cn(surfaceClassName, interactive && cn('cursor-pointer', focusRing))}
        >
          {details}
        </button>
      )}
      {onDelete && <RemoveFile onRemove={onDelete} />}
    </div>
  );
};

export default FileContainer;
