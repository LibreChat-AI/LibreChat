import { useId, useRef, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import { MenuButton } from '@ariakit/react';
import { FileSources } from 'librechat-data-provider';
import { getPreviewKind, shouldUseExtractedTextPreview } from '@librechat/chat';
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
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import { formatFileSize, getDownloadFilename, triggerDownload } from '~/utils';
import { useFileDownload } from '~/data-provider';
import { useLocalize } from '~/hooks';

const downloadable = new Set([
  FileSources.local,
  FileSources.firebase,
  FileSources.s3,
  FileSources.cloudfront,
  FileSources.azure_blob,
  FileSources.execute_code,
  FileSources.text,
]);

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
  const { refetch, isFetching } = useFileDownload(file.user, file.file_id, { direct: false });
  const original =
    file.source != null &&
    (downloadable.has(file.source) ||
      ((file.source === FileSources.openai || file.source === FileSources.azure) &&
        'model' in file &&
        !!file.model));
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
      show: original,
      disabled: isFetching,
      onClick: async () => {
        const result = await refetch();
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
                [localize('com_ui_context'), file.context],
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
