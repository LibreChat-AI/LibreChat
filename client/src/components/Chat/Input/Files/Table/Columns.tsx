import { useMemo, useState } from 'react';
import { File } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ImagePreview } from '@librechat/chat/components';
import { FileContext, FileSources } from 'librechat-data-provider';
import { Checkbox, TooltipAnchor, useMediaQuery } from '@librechat/client';
import type { ColumnDef } from '@tanstack/react-table';
import type { TFile } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { formatFileSize } from '~/utils';
import { useLocalize } from '~/hooks';

export const labels: Partial<Record<string, TranslationKeys>> = {
  [FileContext.agents]: 'com_ui_agents',
  [FileContext.skill_file]: 'com_ui_skills',
  [FileContext.avatar]: 'com_ui_avatar',
  [FileContext.unknown]: 'com_ui_unknown',
  [FileContext.assistants]: 'com_ui_assistants',
  [FileContext.image_generation]: 'com_ui_image_gen',
  [FileContext.assistants_output]: 'com_ui_assistants_output',
  [FileContext.message_attachment]: 'com_ui_attachment',
  [FileContext.run_artifact]: 'com_ui_published_file',
  [FileSources.azure]: 'com_ui_azure',
  [FileSources.openai]: 'com_ui_openai',
  [FileSources.local]: 'com_ui_host',
};

function Filename({ file, detail }: { file: TFile; detail: string }) {
  const localize = useLocalize();
  const image = file.type?.startsWith('image/') ? file.preview || file.filepath : undefined;
  const [failedImage, setFailedImage] = useState<string>();
  const contextLabel = file.context && labels[file.context];
  const index = file.filename.lastIndexOf('.');
  const extension = index > 0 && index < file.filename.length - 1 ? file.filename.slice(index) : '';
  const stem = extension ? file.filename.slice(0, index) : file.filename;
  return (
    <div className="flex min-w-0 items-center gap-3">
      {image && image !== failedImage ? (
        <span className="shrink-0" onErrorCapture={() => setFailedImage(image)}>
          <ImagePreview
            url={image}
            source={file.source}
            alt={file.filename}
            className="size-9 shrink-0"
          />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="bg-surface-secondary text-text-secondary flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold"
        >
          {extension.length > 1 && extension.length <= 5 ? (
            extension.slice(1).toUpperCase()
          ) : (
            <File className="size-4" />
          )}
        </span>
      )}
      <div className="min-w-0">
        <TooltipAnchor
          description={file.filename}
          render={
            <span
              tabIndex={0}
              aria-label={file.filename}
              className="flex max-w-full items-baseline"
            >
              <span className="truncate">{stem}</span>
              <span className="max-w-[45%] shrink-0 truncate">{extension}</span>
            </span>
          }
        />
        {file.context && file.context !== FileContext.unknown && (
          <span className="text-text-secondary block truncate text-xs">
            {contextLabel ? localize(contextLabel) : file.context}
          </span>
        )}
        {detail && <span className="text-text-secondary block truncate text-xs">{detail}</span>}
      </div>
    </div>
  );
}

export function useColumns(): ColumnDef<TFile>[] {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const narrow = useMediaQuery('(max-width: 639px)');
  return useMemo(() => {
    const formatter = new Intl.DateTimeFormat(i18n.language, {
      day: 'numeric',
      month: narrow ? 'numeric' : 'short',
      year: narrow ? '2-digit' : 'numeric',
    });
    function updated(file: TFile) {
      const date = new Date(file.updatedAt ?? '');
      return Number.isNaN(date.getTime()) ? '' : formatter.format(date);
    }
    return [
      {
        id: 'select',
        size: 44,
        enableSorting: false,
        header: ({ table }) => (
          <Checkbox
            aria-label={localize('com_ui_select_all')}
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && 'indeterminate')
            }
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={localize('com_files_select_named', { 0: row.original.filename })}
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
          />
        ),
      },
      {
        accessorKey: 'filename',
        header: localize('com_ui_name'),
        cell: ({ row }) => (
          <Filename
            file={row.original}
            detail={
              narrow
                ? [updated(row.original), formatFileSize(row.original.bytes)]
                    .filter(Boolean)
                    .join(' · ')
                : ''
            }
          />
        ),
      },
      {
        accessorKey: 'updatedAt',
        header: localize('com_ui_sort_updated'),
        size: 145,
        cell: ({ row }) => updated(row.original),
      },
      {
        accessorKey: 'bytes',
        header: localize('com_ui_size'),
        size: 100,
        cell: ({ row }) => formatFileSize(row.original.bytes),
      },
      { accessorKey: 'source', filterFn: 'equalsString' },
      { accessorKey: 'context', filterFn: 'equalsString' },
    ];
  }, [localize, i18n.language, narrow]);
}
