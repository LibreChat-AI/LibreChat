import { memo } from 'react';
import { Switch } from '@librechat/client';
import { FileText, Image as ImageIcon } from 'lucide-react';
import type { SessionFilesView } from './useFiles';
import type { TranslationKeys } from '~/hooks';
import type { FileRow } from './rows';
import Section from '../BackgroundTasks/Section';
import { cn, formatFileSize } from '~/utils';
import { useLocalize } from '~/hooks';

const deliveryKeys: Record<FileRow['delivery'], TranslationKeys | undefined> = {
  file: 'com_ui_session_file_to_model',
  text: 'com_ui_session_file_as_text',
  none: undefined,
};

/** What happens to the file, in the reader's words rather than the storage's. */
function useFileLabels(row: FileRow): string[] {
  const localize = useLocalize();
  const delivery = deliveryKeys[row.delivery];
  return [
    ...(row.made ? [localize('com_ui_session_file_made')] : []),
    ...(delivery ? [localize(delivery)] : []),
    ...(row.search ? [localize('com_ui_session_file_search')] : []),
    ...(row.code ? [localize('com_ui_session_file_code')] : []),
  ];
}

const FileItem = memo(function FileItem({
  row,
  excluded,
  known,
  onChange,
}: {
  row: FileRow;
  excluded: boolean;
  /** Whether the conversation's stored choice for this file has been read. */
  known: boolean;
  onChange: (fileId: string, excluded: boolean) => void;
}) {
  const localize = useLocalize();
  const labels = useFileLabels(row);
  const image = row.type?.startsWith('image/') === true;
  const Icon = image ? ImageIcon : FileText;
  /** A file a message refers to only from its content has no name of its own stored with it. */
  const name =
    row.name ||
    localize(image ? 'com_ui_session_file_unnamed_image' : 'com_ui_session_file_unnamed');
  const detail = [
    ...(excluded ? [localize('com_ui_session_file_left_out')] : labels),
    ...(row.bytes != null ? [formatFileSize(row.bytes)] : []),
  ].join(' · ');
  return (
    <li
      data-testid="session-file"
      data-excluded={excluded || undefined}
      className="flex min-h-11 items-center gap-2 rounded-lg px-2 py-1.5"
    >
      <Icon
        aria-hidden="true"
        className={cn('size-4 shrink-0', excluded ? 'text-text-tertiary' : 'text-text-secondary')}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-sm',
            excluded ? 'text-text-secondary' : 'text-text-primary',
          )}
          title={name}
        >
          {name}
        </span>
        <span className="text-text-secondary block truncate text-xs">{detail}</span>
      </span>
      <Switch
        checked={!excluded}
        disabled={!known}
        onCheckedChange={(checked) => onChange(row.id, !checked)}
        aria-label={localize('com_ui_session_file_include', { 0: name })}
      />
    </li>
  );
});

/**
 * The conversation's files and whether each is still sent along with new messages. A file left
 * out stays on the message that carried it; it is only no longer sent to the model or handed to
 * its tools.
 */
export default function Files({ view }: { view: SessionFilesView }) {
  const localize = useLocalize();
  const { rows, excluded, known, setExcluded, failed, retry } = view;
  if (rows.length === 0) {
    return null;
  }
  const leftOut = rows.filter((row) => excluded.has(row.id)).length;
  return (
    <Section
      dense
      label={localize('com_ui_session_files')}
      count={rows.length}
      action={
        leftOut > 0 ? (
          <span className="text-text-secondary pe-1 text-xs tabular-nums">
            {localize('com_ui_session_files_left_out', { 0: String(leftOut) })}
          </span>
        ) : undefined
      }
    >
      {failed === 'load' && (
        <li role="alert" className="text-status-error px-2 pb-1 text-xs">
          <p>{localize('com_ui_session_files_load_failed')}</p>
          <button
            type="button"
            className="text-text-primary focus-visible:ring-focus-control mt-1 rounded underline focus-visible:ring-2 focus-visible:outline-none"
            onClick={retry}
          >
            {localize('com_ui_retry')}
          </button>
        </li>
      )}
      {(failed === 'error' || failed === 'full') && (
        <li role="alert" className="text-status-error px-2 pb-1 text-xs">
          {localize(
            failed === 'full' ? 'com_ui_session_files_full' : 'com_ui_session_files_failed',
          )}
        </li>
      )}
      {rows.map((row) => (
        <FileItem
          key={row.id}
          row={row}
          excluded={excluded.has(row.id)}
          known={known}
          onChange={setExcluded}
        />
      ))}
    </Section>
  );
}
