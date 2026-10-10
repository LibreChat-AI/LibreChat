import { useEffect, useState, useMemo, useCallback } from 'react';
import filenamify from 'filenamify';
import {
  Input,
  Label,
  Button,
  OGDialog,
  Checkbox,
  Dropdown,
  OGDialogTemplate,
} from '@librechat/client';
import type { TConversation } from 'librechat-data-provider';
import { useLocalize, useExportConversation } from '~/hooks';
import { normalizeExportFilename } from '~/utils';

const TYPE_OPTIONS = [
  { value: 'markdown', label: 'markdown (.md)' },
  { value: 'text', label: 'text (.txt)' },
  { value: 'json', label: 'json (.json)' },
  { value: 'csv', label: 'csv (.csv)' },
  { value: 'screenshot', label: 'screenshot (.png)' },
];

const DEFAULT_TYPE = 'markdown';

export default function ExportModal({
  open,
  onOpenChange,
  conversation,
  triggerRef,
  children,
}: {
  open: boolean;
  conversation: TConversation | null;
  onOpenChange: React.Dispatch<React.SetStateAction<boolean>>;
  triggerRef?: React.RefObject<HTMLButtonElement>;
  children?: React.ReactNode;
}) {
  const localize = useLocalize();

  const [filename, setFileName] = useState('');
  const [type, setType] = useState<string>(DEFAULT_TYPE);

  const [includeOptions, setIncludeOptions] = useState<boolean | 'indeterminate'>(true);
  const [exportBranches, setExportBranches] = useState<boolean | 'indeterminate'>(false);
  const [recursive, setRecursive] = useState<boolean | 'indeterminate'>(true);

  useEffect(() => {
    if (!open && triggerRef && triggerRef.current) {
      triggerRef.current.focus();
    }
  }, [open, triggerRef]);

  useEffect(() => {
    setFileName(filenamify(String(conversation?.title ?? 'file')));
    setType(DEFAULT_TYPE);
    setIncludeOptions(true);
    setExportBranches(false);
    setRecursive(true);
  }, [conversation?.title, open]);

  const handleTypeChange = useCallback((newType: string) => {
    const branches = newType === 'json' || newType === 'csv';
    const options = newType !== 'csv' && newType !== 'screenshot';
    setExportBranches(branches);
    setIncludeOptions(options);
    setType(newType);
  }, []);

  const exportBranchesSupport = useMemo(() => type === 'json' || type === 'csv', [type]);
  const exportOptionsSupport = useMemo(() => type !== 'csv' && type !== 'screenshot', [type]);

  const { exportConversation } = useExportConversation({
    conversation,
    filename: normalizeExportFilename(filenamify(filename)),
    type,
    includeOptions,
    exportBranches,
    recursive,
  });

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      {children}
      <OGDialogTemplate
        title={localize('com_nav_export_conversation')}
        className="max-w-full sm:max-w-2xl"
        main={
          <div className="flex w-full flex-col items-center gap-6">
            <div className="grid w-full gap-6 sm:grid-cols-2">
              <div className="col-span-1 flex flex-col items-start justify-start gap-2">
                <Label htmlFor="filename" className="text-left text-sm font-medium">
                  {localize('com_nav_export_filename')}
                </Label>
                <Input
                  id="filename"
                  value={filename}
                  onChange={(e) => setFileName(e.target.value || '')}
                  placeholder={localize('com_nav_export_filename_placeholder')}
                />
              </div>
              <div className="col-span-1 flex w-full flex-col items-start justify-start gap-2">
                <Label htmlFor="type" className="text-left text-sm font-medium">
                  {localize('com_nav_export_type')}
                </Label>
                <Dropdown
                  value={type}
                  onChange={handleTypeChange}
                  options={TYPE_OPTIONS}
                  sizeClasses="z-50"
                  className="z-50"
                  portal={false}
                />
              </div>
            </div>
            <div className="grid w-full gap-6 sm:grid-cols-2">
              <div className="col-span-1 flex flex-col items-start justify-start gap-2">
                <div className="grid w-full items-center gap-2">
                  <Label htmlFor="includeOptions" className="text-left text-sm font-medium">
                    {localize('com_nav_export_include_endpoint_options')}
                  </Label>
                  <div className="flex h-[2.5rem] w-full items-center space-x-3">
                    <Checkbox
                      id="includeOptions"
                      disabled={!exportOptionsSupport}
                      checked={includeOptions}
                      onCheckedChange={setIncludeOptions}
                      aria-labelledby="includeOptions-label"
                    />
                    <Label
                      id="includeOptions-label"
                      htmlFor="includeOptions"
                      className="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {exportOptionsSupport
                        ? localize('com_nav_export_include_endpoint_options')
                        : localize('com_nav_not_supported')}
                    </Label>
                  </div>
                </div>
              </div>
              <div className="grid w-full items-center gap-2">
                <Label htmlFor="exportBranches" className="text-left text-sm font-medium">
                  {localize('com_nav_export_all_message_branches')}
                </Label>
                <div className="flex h-[2.5rem] w-full items-center space-x-3">
                  <Checkbox
                    id="exportBranches"
                    disabled={!exportBranchesSupport}
                    checked={exportBranches}
                    onCheckedChange={setExportBranches}
                    aria-labelledby="exportBranches-label"
                  />
                  <Label
                    id="exportBranches-label"
                    htmlFor="exportBranches"
                    className="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    {exportBranchesSupport
                      ? localize('com_nav_export_all_message_branches')
                      : localize('com_nav_not_supported')}
                  </Label>
                </div>
              </div>
              {type === 'json' ? (
                <div className="grid w-full items-center gap-2">
                  <Label htmlFor="recursive" className="text-left text-sm font-medium">
                    {localize('com_nav_export_recursive_or_sequential')}
                  </Label>
                  <div className="flex h-[2.5rem] w-full items-center space-x-3">
                    <Checkbox
                      id="recursive"
                      checked={recursive}
                      onCheckedChange={setRecursive}
                      aria-labelledby="recursive-label"
                    />
                    <Label
                      id="recursive-label"
                      htmlFor="recursive"
                      className="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {localize('com_nav_export_recursive')}
                    </Label>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        }
        buttons={
          <>
            <Button onClick={exportConversation} variant="submit">
              {localize('com_endpoint_export')}
            </Button>
          </>
        }
        selection={undefined}
      />
    </OGDialog>
  );
}
