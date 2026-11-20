import { memo } from 'react';
import { Switch } from '@librechat/client';
import { FileText, Image as ImageIcon } from 'lucide-react';
import type { SessionFilesView } from './useFiles';
import type { TranslationKeys } from '~/hooks';
import type { FileRow } from './files';
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
  onChange,
}: {
  row: FileRow;
  excluded: boolean;
  onChange: (fileId: string, excluded: boolean) => void;
}) {
  const localize = useLocalize();
  const labels = useFileLabels(row);
  const Icon = row.type?.startsWith('image/') ? ImageIcon : FileText;
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
          title={row.name}
        >
          {row.name}
        </span>
        <span className="text-text-secondary block truncate text-xs">{detail}</span>
      </span>
      <Switch
        checked={!excluded}
        onCheckedChange={(checked) => onChange(row.id, !checked)}
        aria-label={localize('com_ui_session_file_include', { 0: row.name })}
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
  const { rows, excluded, setExcluded, failed } = view;
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
      {failed !== false && (
        <li role="alert" className="text-status-error px-2 pb-1 text-xs">
          {localize(
            failed === 'full' ? 'com_ui_session_files_full' : 'com_ui_session_files_failed',
          )}
        </li>
      )}
      {rows.map((row) => (
        <FileItem key={row.id} row={row} excluded={excluded.has(row.id)} onChange={setExcluded} />
      ))}
    </Section>
  );
}
