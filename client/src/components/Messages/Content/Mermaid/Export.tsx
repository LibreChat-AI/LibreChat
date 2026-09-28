import React, { memo, useCallback, useId, useMemo, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { DropdownPopup, TooltipAnchor, useToastContext } from '@librechat/client';
import { FileCode2, FileImage, ImageDown, LoaderCircle, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { MermaidDimensions } from '~/utils/diagram/export';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { MenuItemProps } from '~/common';
import { downloadMermaidPng, downloadMermaidSvg } from '~/utils/diagram/export';
import { useLocalize } from '~/hooks';
import cn from '~/utils/cn';

interface MermaidExportProps {
  filename: string;
  svg?: string | null;
  dimensions?: MermaidDimensions | null;
  buttonClassName?: string;
  /** Fullscreen re-roots the panel, so a menu portalled to the body would be
   *  rendered outside the visible fullscreen element. */
  portalElement?: HTMLElement | null;
  /**
   * Saves the diagram's own source. Supplied only by the artifacts panel,
   * where this menu replaces the generic download button rather than sitting
   * next to it — one control that offers every form the diagram comes in,
   * instead of two buttons whose difference is invisible until you press one.
   * Unlike the rendered formats it does not need a preview, so it stays
   * available while the panel is on the code tab.
   */
  onDownloadSource?: (
    event: React.MouseEvent<HTMLElement>,
  ) => boolean | void | Promise<boolean | void>;
}

function surfaceBackground(): string | undefined {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--surface-primary-alt')
    .trim();
  if (!value) {
    return undefined;
  }
  if (/^[\d.]+(?:\s+[\d.]+){2}(?:\s*\/\s*[\d.]+%?)?$/.test(value)) {
    return `rgb(${value})`;
  }
  return value.startsWith('var(') ? undefined : value;
}

type ExportFormat = 'svg' | 'png' | 'source';

/** Rendered formats, in menu order. Each needs the preview's SVG. */
const EXPORT_FORMATS = [
  { format: 'svg', labelKey: 'com_ui_export_svg', Icon: FileCode2 },
  { format: 'png', labelKey: 'com_ui_export_png', Icon: FileImage },
] as const satisfies ReadonlyArray<{
  format: Exclude<ExportFormat, 'source'>;
  labelKey: TranslationKeys;
  Icon: LucideIcon;
}>;

const EXPORTING_KEYS: Record<ExportFormat, TranslationKeys> = {
  svg: 'com_ui_mermaid_exporting_svg',
  png: 'com_ui_mermaid_exporting_png',
  source: 'com_ui_mermaid_exporting_source',
};

const MermaidExport = memo(function MermaidExport({
  filename,
  svg,
  dimensions,
  buttonClassName,
  portalElement,
  onDownloadSource,
}: MermaidExportProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportStatus, setExportStatus] = useState('');
  const isBusy = exporting != null;
  const liveMessage = exporting == null ? exportStatus : localize(EXPORTING_KEYS[exporting]);

  /* A task that throws told nobody, so the menu raises the toast itself. */
  const showExportError = useCallback(() => {
    setExportStatus(localize('com_ui_mermaid_export_failed'));
    showToast({ status: 'error', message: localize('com_ui_mermaid_export_failed') });
  }, [localize, showToast]);

  /* A task that reports `false` failed inside a layer that names the cause
   * better than this menu can — `useAttachmentLink` already toasts
   * "Error downloading file" — so only the live region speaks here, or one
   * press raises two toasts. */
  const announceExportError = useCallback(() => {
    setExportStatus(localize('com_ui_mermaid_export_failed'));
  }, [localize]);

  const restoreTriggerFocus = useCallback(() => {
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  /**
   * Runs `task` after the browser has had a rendering opportunity, not
   * merely in a later task: a bare `setTimeout` can fire before the paint
   * that would have shown the loading row, which is the whole point of
   * deferring a synchronous export. A hidden tab serves no animation
   * frames, and an export must not stall until refocus, so fall back to a
   * timer there.
   */
  const deferPastPaint = useCallback((task: () => void) => {
    if (typeof requestAnimationFrame !== 'function' || document.hidden) {
      setTimeout(task, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(task, 0));
  }, []);

  /**
   * Every menu action runs through here so the menu can show the in-flight
   * one as its own loading row rather than growing an extra status row
   * beside options that still look idle.
   *
   * The work waits for a paint (see `deferPastPaint`). That matters most for
   * SVG, whose export is synchronous: calling it inline blocks the frame
   * that would have shown its spinner, so a large diagram froze the open
   * menu with both options looking idle.
   */
  const runExport = useCallback(
    (format: ExportFormat, task: () => boolean | void | Promise<boolean | void>) => {
      if (exporting != null) {
        return;
      }
      setExporting(format);
      setExportStatus('');
      deferPastPaint(() => {
        void Promise.resolve()
          .then(task)
          .then((delivered) => {
            /* A task that reports `false` delivered nothing — the source
             * download fetches the stored file and swallows an expired or
             * denied route — so the menu must not announce completion. */
            if (delivered === false) {
              announceExportError();
              return;
            }
            setExportStatus(localize('com_ui_mermaid_export_complete'));
          })
          .catch(showExportError)
          .finally(() => setExporting(null));
      });
      restoreTriggerFocus();
    },
    [
      announceExportError,
      deferPastPaint,
      exporting,
      localize,
      restoreTriggerFocus,
      showExportError,
    ],
  );

  const handleSvgExport = useCallback(() => {
    if (svg == null) {
      return;
    }
    runExport('svg', () => downloadMermaidSvg(svg, filename, surfaceBackground()));
  }, [filename, runExport, svg]);

  const handlePngExport = useCallback(() => {
    if (svg == null) {
      return;
    }
    runExport('png', () => downloadMermaidPng(svg, filename, dimensions, surfaceBackground()));
  }, [dimensions, filename, runExport, svg]);

  const handleSourceExport = useCallback(
    (event: React.MouseEvent<HTMLButtonElement | HTMLDivElement>) => {
      if (onDownloadSource == null) {
        return;
      }
      runExport('source', () => onDownloadSource(event));
    },
    [onDownloadSource, runExport],
  );

  /**
   * The visible label collapses to a generic "Loading…" so the row reads as
   * the control the user just pressed; the format-specific phrase stays on
   * `ariaLabel`, which is what a screen reader announces, so "which export"
   * is not lost to the swap.
   */
  const dropdownItems = useMemo<MenuItemProps[]>(() => {
    const loadingRow = (format: ExportFormat) => ({
      label: localize('com_ui_loading'),
      ariaLabel: localize(EXPORTING_KEYS[format]),
      icon: <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />,
      className: 'text-text-secondary',
    });
    const items: MenuItemProps[] = EXPORT_FORMATS.map(({ format, labelKey, Icon }) => ({
      label: localize(labelKey),
      icon: <Icon className="size-4 text-text-secondary" />,
      ...(exporting === format ? loadingRow(format) : {}),
      disabled: svg == null || isBusy,
      onClick: format === 'svg' ? handleSvgExport : handlePngExport,
    }));
    if (onDownloadSource != null) {
      items.push({
        label: localize('com_ui_export_mermaid_source'),
        icon: <Workflow className="size-4 text-text-secondary" />,
        ...(exporting === 'source' ? loadingRow('source') : {}),
        /* The source is the artifact's own content, so unlike SVG and PNG it
         * does not wait on a rendered preview. */
        disabled: isBusy,
        onClick: handleSourceExport,
      });
    }
    return items;
  }, [
    exporting,
    handlePngExport,
    handleSourceExport,
    handleSvgExport,
    isBusy,
    localize,
    onDownloadSource,
    svg,
  ]);

  return (
    <>
      <DropdownPopup
        portal
        focusLoop
        unmountOnHide
        menuId={`mermaid-export-${instanceId}-menu`}
        finalFocus={triggerRef}
        isOpen={isOpen}
        setIsOpen={setIsOpen}
        items={dropdownItems}
        portalElement={portalElement}
        className="absolute right-0 top-0 mt-2 min-w-52 motion-reduce:!transition-none"
        trigger={
          <TooltipAnchor
            portalElement={portalElement}
            description={isBusy ? liveMessage : localize('com_ui_export_mermaid')}
            render={
              <Ariakit.MenuButton
                ref={triggerRef}
                aria-label={localize('com_ui_export_mermaid')}
                aria-busy={isBusy || undefined}
                className={cn(
                  'flex items-center justify-center rounded-lg p-1.5 text-text-secondary transition-colors motion-reduce:transition-none',
                  'hover:bg-surface-hover hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-heavy',
                  buttonClassName,
                )}
              >
                {isBusy ? (
                  <LoaderCircle
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <ImageDown className="size-4" aria-hidden="true" />
                )}
              </Ariakit.MenuButton>
            }
          />
        }
      />
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </span>
    </>
  );
});

MermaidExport.displayName = 'MermaidExport';

export default MermaidExport;
