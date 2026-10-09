import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import copy from 'copy-to-clipboard';
import { Constants } from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

const UNKNOWN_PLACEHOLDER = '—';

function formatBuildDate(raw: string | null | undefined): string {
  if (!raw) {
    return UNKNOWN_PLACEHOLDER;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function buildDiagnosticsBlob(
  version: string,
  buildInfo: TStartupConfig['buildInfo'] | undefined,
): string {
  const lines: string[] = [
    `LibreChat version: ${version}`,
    `Commit: ${buildInfo?.commit ?? UNKNOWN_PLACEHOLDER}`,
    `Branch: ${buildInfo?.branch ?? UNKNOWN_PLACEHOLDER}`,
    `Build date: ${formatBuildDate(buildInfo?.buildDate)}`,
    `User agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : UNKNOWN_PLACEHOLDER}`,
  ];
  return lines.join('\n');
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="break-all text-right font-mono text-xs text-text-primary">{value}</dd>
    </div>
  );
}

function About() {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const [isCopied, setIsCopied] = useState(false);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildInfo = startupConfig?.buildInfo;
  const version: string = Constants.VERSION;

  const diagnosticsBlob = useMemo(
    () => buildDiagnosticsBlob(version, buildInfo),
    [version, buildInfo],
  );

  useEffect(
    () => () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(() => {
    const succeeded = copy(diagnosticsBlob, { format: 'text/plain' });
    if (!succeeded) {
      return;
    }
    setIsCopied(true);
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = setTimeout(() => setIsCopied(false), 2000);
  }, [diagnosticsBlob]);

  return (
    <div className="flex flex-col text-sm text-text-primary">
      <dl className="flex flex-col divide-y divide-border-light">
        <Row label={localize('com_nav_about_version')} value={version} />
        <Row
          label={localize('com_nav_about_commit')}
          value={buildInfo?.commitShort ?? UNKNOWN_PLACEHOLDER}
        />
        <Row
          label={localize('com_nav_about_branch')}
          value={buildInfo?.branch ?? UNKNOWN_PLACEHOLDER}
        />
        <Row
          label={localize('com_nav_about_build_date')}
          value={formatBuildDate(buildInfo?.buildDate)}
        />
      </dl>

      <div className="mt-4 flex flex-col items-start gap-3 border-t border-border-light pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="min-w-0 flex-1 text-xs text-text-secondary">
          {localize('com_nav_about_diagnostics_description')}
        </p>
        <CopyButton
          isCopied={isCopied}
          onClick={handleCopy}
          label={localize('com_nav_about_diagnostics_copy')}
          className="ml-0 shrink-0 gap-2 self-start rounded-lg border border-border-light bg-surface-secondary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-tertiary sm:self-auto"
        />
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {isCopied ? localize('com_ui_copied') : ''}
        </span>
      </div>
    </div>
  );
}

export default memo(About);
