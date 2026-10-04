import { useEffect, useRef, useState } from 'react';
import { Link, Paperclip, Upload } from 'lucide-react';
import {
  Button,
  FileUpload,
  ControlCombobox,
  Input,
  Label,
  Spinner,
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  OGDialogDescription,
  OGDialogFooter,
  TooltipAnchor,
} from '@librechat/client';
import type { MediaURLUploadRequest } from 'librechat-data-provider';
import { mediaInputRoleLabels } from './labels';
import { useLocalize } from '~/hooks';

type HostedRole = MediaURLUploadRequest['role'];

export function MediaReferenceUpload({
  id,
  ownerKey,
  hostedRoles,
  localAccept,
  disabled,
  uploading,
  url,
  role,
  valid,
  error,
  onURLChange,
  onRoleChange,
  uploadURL,
  uploadFile,
  cancel,
}: {
  id: string;
  ownerKey: string;
  hostedRoles: readonly HostedRole[];
  localAccept: string;
  disabled: boolean;
  uploading: boolean;
  url: string;
  role?: HostedRole;
  valid: boolean;
  error?: string;
  onURLChange: (url: string) => void;
  onRoleChange: (role: HostedRole) => void;
  uploadURL: () => Promise<boolean>;
  uploadFile: (file: File) => Promise<boolean>;
  cancel: () => void;
}) {
  const localize = useLocalize();
  const [dialogOwner, setDialogOwner] = useState<string>();
  const contextKey = JSON.stringify([ownerKey, hostedRoles, localAccept]);
  const currentOwner = useRef(contextKey);
  currentOwner.current = contextKey;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  const trigger = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<{ owner: string }>();
  const open = dialogOwner === contextKey && hostedRoles.length > 0;
  useEffect(() => {
    setDialogOwner(undefined);
    pending.current = undefined;
    return () => cancelRef.current();
  }, [contextKey]);
  const close = () => {
    pending.current = undefined;
    cancel();
    setDialogOwner(undefined);
  };
  async function run(load: () => Promise<boolean>) {
    if (pending.current?.owner === contextKey || disabled || uploading) return;
    const attempt = { owner: contextKey };
    pending.current = attempt;
    try {
      if ((await load()) && currentOwner.current === contextKey && pending.current === attempt)
        setDialogOwner(undefined);
    } finally {
      if (pending.current === attempt) pending.current = undefined;
    }
  }
  return (
    <>
      {localAccept && (
        <FileUpload
          ref={fileInput}
          id={`${id}-upload`}
          multiple={false}
          accept={localAccept}
          aria-label={localize('com_media_upload')}
          disabled={disabled || uploading}
          handleFileChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void run(() => uploadFile(file));
          }}
        >
          {null}
        </FileUpload>
      )}
      <TooltipAnchor
        description={localize('com_media_upload')}
        render={
          <Button
            ref={trigger}
            variant="composer"
            size="icon-theme"
            shape="round"
            aria-label={localize('com_media_upload')}
            disabled={disabled || uploading || (!localAccept && !hostedRoles.length)}
            onClick={() =>
              hostedRoles.length ? setDialogOwner(contextKey) : fileInput.current?.click()
            }
          >
            <Paperclip className="icon-md" aria-hidden="true" />
          </Button>
        }
      />
      {uploading && !open && (
        <>
          <Spinner className="size-4" />
          <Button variant="ghost" size="sm" onClick={close}>
            {localize('com_ui_cancel')}
          </Button>
        </>
      )}
      <OGDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <OGDialogContent
          className="w-11/12 max-w-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <OGDialogHeader>
            <OGDialogTitle>{localize('com_media_upload')}</OGDialogTitle>
            <OGDialogDescription>{localize('com_media_reference_url_hint')}</OGDialogDescription>
          </OGDialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (valid) void run(uploadURL);
            }}
          >
            {hostedRoles.length > 1 && (
              <ControlCombobox
                showCarat
                ariaLabel={localize('com_media_reference_url_role')}
                variant="field"
                isCollapsed={false}
                portal={false}
                selectedValue={role ?? ''}
                displayValue={role ? localize(mediaInputRoleLabels[role]) : undefined}
                items={hostedRoles.map((value) => ({
                  value,
                  label: localize(mediaInputRoleLabels[value]),
                }))}
                disabled={uploading || disabled}
                setValue={(value) => {
                  if (value === 'video' || value === 'audio') onRoleChange(value);
                }}
              />
            )}
            <div className="space-y-2">
              <Label htmlFor={`${id}-reference-url`}>{localize('com_media_reference_url')}</Label>
              <Input
                id={`${id}-reference-url`}
                type="url"
                value={url}
                disabled={uploading || disabled}
                aria-invalid={(!!url.trim() && !valid) || undefined}
                onChange={(event) => onURLChange(event.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-text-destructive text-sm">
                {error}
              </p>
            )}
            {uploading && (
              <p role="status" className="text-text-secondary flex items-center gap-2 text-sm">
                <Spinner className="size-4" />
                {localize('com_media_reference_loading')}
              </p>
            )}
            <OGDialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                {localize('com_ui_cancel')}
              </Button>
              <Button type="submit" variant="submit" disabled={disabled || uploading || !valid}>
                <Link className="mr-1.5 size-4" aria-hidden="true" />
                {localize('com_media_add_reference_url')}
              </Button>
            </OGDialogFooter>
          </form>
          {localAccept && (
            <div className="border-border-light space-y-2 border-t pt-4">
              <p className="text-text-secondary text-sm">
                {localize('com_media_local_reference_hint')}
              </p>
              <Button
                variant="outline"
                disabled={disabled || uploading}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="mr-1.5 size-4" aria-hidden="true" />
                {localize('com_media_local_reference')}
              </Button>
            </div>
          )}
        </OGDialogContent>
      </OGDialog>
    </>
  );
}
