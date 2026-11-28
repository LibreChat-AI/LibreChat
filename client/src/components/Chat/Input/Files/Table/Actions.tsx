import { useId, useRef, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import { MenuButton } from '@ariakit/react';
import { getPreviewKind, shouldUseExtractedTextPreview } from '@librechat/chat';
import { apiBaseUrl, FileSources, checkOpenAIStorage } from 'librechat-data-provider';
import {
  Button,
  DropdownPopup,
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  useToastContext,
} from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import type { MenuItemProps } from '~/common';
import { isLocallyStoredSource } from '~/components/Chat/Messages/Content/Parts/LogLink';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import { formatFileSize, getDownloadFilename, triggerDownload } from '~/utils';
import { useCodeOutputDownload, useFileDownload } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { labels } from './labels';

export default function Actions({
  file,
  onDelete,
}: {
  file: TFile;
  onDelete: (file: TFile, trigger: HTMLElement | null) => void;
}) {
  const id = useId();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<'details' | 'preview'>();
  const details = useRef<HTMLButtonElement>(null);
  const preview = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const owned = useFileDownload(file.user, file.file_id, { direct: false });
  const prefix = apiBaseUrl() + '/api/files/code/download/';
  const codePath =
    file.source === FileSources.execute_code &&
    file.filepath?.startsWith(prefix) &&
    /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+(?:\?[^#]*)?$/.test(file.filepath.slice(prefix.length))
      ? file.filepath
      : undefined;
  const code = useCodeOutputDownload(codePath);
  const download = codePath ? code : owned;
  const original =
    isLocallyStoredSource(file.source) ||
    (file.source != null && checkOpenAIStorage(file.source) && 'model' in file && !!file.model);
  const contextKey = file.context && labels[file.context];
  const context =
    contextKey && file.context
      ? localize('com_files_label_and_identifier', {
          label: localize(contextKey),
          value: file.context,
        })
      : file.context;
  const canPreview =
    (original && !!getPreviewKind(file.filename, file.type, file.source)) ||
    shouldUseExtractedTextPreview(file.llmDeliveryPath);
  const items: MenuItemProps[] = [
    {
      label: localize('com_ui_details'),
      hideOnClick: false,
      ref: details,
      render: <Button variant="ghost" />,
      onClick: () => setDialog('details'),
    },
    {
      label: localize('com_ui_preview'),
      show: canPreview,
      hideOnClick: false,
      ref: preview,
      render: <Button variant="ghost" />,
      onClick: () => setDialog('preview'),
    },
    {
      label: localize('com_ui_download'),
      show: original || !!codePath,
      disabled: download.isFetching,
      onClick: async () => {
        const result = await download.refetch();
        if (result.isError || !result.data) {
          showToast({ status: 'error', message: localize('com_ui_download_error') });
          return;
        }
        triggerDownload(result.data, getDownloadFilename(file.filename, file.file_id, file.source));
      },
    },
    { label: localize('com_ui_delete'), onClick: () => onDelete(file, trigger.current) },
  ];
  return (
    <>
      <DropdownPopup
        menuId={id}
        items={items}
        isOpen={menu}
        setIsOpen={setMenu}
        trigger={
          <MenuButton
            ref={trigger}
            render={<Button variant="ghost" size="icon" />}
            aria-label={localize('com_files_actions_named', { 0: file.filename })}
          >
            <Ellipsis aria-hidden="true" />
          </MenuButton>
        }
      />
      {dialog === 'details' && (
        <OGDialog open onOpenChange={(open) => !open && setDialog(undefined)} triggerRef={details}>
          <OGDialogContent title={localize('com_ui_details')} className="w-11/12 max-w-md">
            <OGDialogHeader>
              <OGDialogTitle>{localize('com_ui_details')}</OGDialogTitle>
            </OGDialogHeader>
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              {[
                [localize('com_ui_name'), file.filename],
                [localize('com_ui_size'), formatFileSize(file.bytes)],
                [localize('com_ui_storage'), file.source],
                [localize('com_ui_context'), context],
              ].map(([label, value]) => (
                <div className="contents" key={label}>
                  <dt className="text-text-secondary">{label}</dt>
                  <dd className="break-all">{value || localize('com_ui_unknown')}</dd>
                </div>
              ))}
            </dl>
          </OGDialogContent>
        </OGDialog>
      )}
      {dialog === 'preview' && (
        <FilePreviewDialog
          open
          onOpenChange={(open) => !open && setDialog(undefined)}
          triggerRef={preview}
          fileName={file.filename}
          fileId={file.file_id}
          fileType={file.type}
          fileSource={file.source}
          fileSize={file.bytes}
          deliveryPath={file.llmDeliveryPath}
        />
      )}
    </>
  );
}
