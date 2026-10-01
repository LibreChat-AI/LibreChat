import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Input,
  Label,
  PasskeyIcon,
  SecretInput,
  Spinner,
  TooltipAnchor,
} from '@librechat/client';
import type { TPasskey } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

const MAX_NAME_LENGTH = 60;

/** Moves focus into the rename field as it mounts, then selects the current label. */
const focusOnMount = (input: HTMLInputElement | null): void => {
  input?.select();
};

const formatDate = (value: string | null): string | null => {
  if (value == null || value === '') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
};

/** Restores focus to the rename control after the inline editor unmounts. */
const returnRenameFocusRef =
  (pending: React.MutableRefObject<boolean>) =>
  (button: HTMLButtonElement | null): void => {
    if (button && pending.current) {
      pending.current = false;
      button.focus();
    }
  };

/** Outcome of a removal attempt, so a rejected password lands next to its field. */
export type PasskeyRemovalResult = 'removed' | 'incorrect-password' | 'failed';

type PasskeyItemProps = {
  passkey: TPasskey;
  isRenaming: boolean;
  isBusy: boolean;
  /** False for an account with no local password, which cannot be asked for one. */
  requiresPassword: boolean;
  onStartRename: (passkeyId: string | null) => void;
  onRename: (passkeyId: string, name: string) => void;
  onDelete: (passkeyId: string, password: string) => Promise<PasskeyRemovalResult>;
};

function PasskeyItem({
  passkey,
  isRenaming,
  isBusy,
  requiresPassword,
  onStartRename,
  onRename,
  onDelete,
}: PasskeyItemProps) {
  const localize = useLocalize();
  const [draftName, setDraftName] = useState(passkey.name);
  const [isConfirming, setIsConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [hasPasswordError, setHasPasswordError] = useState(false);
  /**
   * The server waives the step-up only for accounts carrying no password hash, which the
   * client cannot see. Reveal the field when the server actually asks, so credentials
   * from an account that changed providers remain removable.
   */
  const [serverDemandedPassword, setServerDemandedPassword] = useState(false);
  const showPasswordField = requiresPassword || serverDemandedPassword;
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const returnFocusToRename = useRef(false);
  const rowId = useId();
  const passwordFieldId = `${rowId}-password`;
  const passwordErrorId = `${rowId}-password-error`;

  const added = formatDate(passkey.createdAt);
  const lastUsed = formatDate(passkey.lastUsedAt);

  const beginRename = useCallback(() => {
    setDraftName(passkey.name);
    onStartRename(passkey.id);
  }, [passkey.id, passkey.name, onStartRename]);

  const cancelRename = useCallback(() => {
    setDraftName(passkey.name);
    returnFocusToRename.current = true;
    onStartRename(null);
  }, [passkey.name, onStartRename]);

  const submitRename = useCallback(() => {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === passkey.name) {
      cancelRename();
      return;
    }
    onRename(passkey.id, trimmed);
  }, [draftName, passkey.id, passkey.name, onRename, cancelRename]);

  /** Callback ref so the step-up field takes focus as soon as it appears. */
  const bindPasswordField = useCallback((input: HTMLInputElement | null) => {
    passwordRef.current = input;
    input?.focus();
  }, []);

  const bindRenameButton = useMemo(() => returnRenameFocusRef(returnFocusToRename), []);

  const handleDeleteOpenChange = useCallback((open: boolean) => {
    setIsConfirming(open);
    setPassword('');
    setHasPasswordError(false);
  }, []);

  const handleDeleteOpenAutoFocus = useCallback(
    (event: Event) => {
      if (!showPasswordField) {
        return;
      }
      event.preventDefault();
      passwordRef.current?.focus();
    },
    [showPasswordField],
  );

  const submitDelete = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setHasPasswordError(false);
      const result = await onDelete(passkey.id, password);
      if (result === 'removed') {
        setPassword('');
        setIsConfirming(false);
        return;
      }
      if (result === 'incorrect-password') {
        setHasPasswordError(true);
        setServerDemandedPassword(true);
      }
      /** Put focus back on the field the error describes so it can be corrected. */
      passwordRef.current?.focus();
    },
    [onDelete, passkey.id, password],
  );

  const onRenameKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitRename();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRename();
      }
    },
    [submitRename, cancelRename],
  );

  return (
    <AlertDialog open={isConfirming} onOpenChange={handleDeleteOpenChange}>
      <div
        className="border-border-light bg-surface-secondary flex items-center gap-3 rounded-xl border px-3 py-2"
        data-testid="passkey-item"
      >
        <span className="text-text-secondary shrink-0">
          <PasskeyIcon className="h-5 w-5" />
        </span>

        {isRenaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Input
              ref={focusOnMount}
              value={draftName}
              maxLength={MAX_NAME_LENGTH}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={onRenameKeyDown}
              aria-label={localize('com_ui_passkey_name')}
              className="h-10"
            />
            <TooltipAnchor
              description={localize('com_ui_save')}
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={submitRename}
                  disabled={isBusy}
                  aria-label={localize('com_ui_save')}
                >
                  <Check className="h-4 w-4" aria-hidden="true" />
                </Button>
              }
            />
            <TooltipAnchor
              description={localize('com_ui_cancel')}
              render={
                <Button
                  variant="secondary"
                  size="icon"
                  className="shrink-0"
                  onClick={cancelRename}
                  aria-label={localize('com_ui_cancel')}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              }
            />
          </div>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <p className="text-text-primary truncate text-sm font-medium">{passkey.name}</p>
              <p className="text-text-secondary truncate text-xs">
                {added != null && localize('com_ui_passkey_added_on', { date: added })}
                {added != null && ' · '}
                {lastUsed != null
                  ? localize('com_ui_passkey_last_used', { date: lastUsed })
                  : localize('com_ui_passkey_never_used')}
              </p>
            </div>

            {passkey.backedUp && (
              <span className="bg-status-success-subtle text-status-success shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
                {localize('com_ui_passkey_synced')}
              </span>
            )}

            <TooltipAnchor
              description={localize('com_ui_passkey_rename')}
              render={
                <Button
                  ref={bindRenameButton}
                  variant="ghost"
                  size="icon"
                  onClick={beginRename}
                  aria-label={localize('com_ui_passkey_rename')}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </Button>
              }
            />
            <TooltipAnchor
              description={localize('com_ui_passkey_remove')}
              render={
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={localize('com_ui_passkey_remove')}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </AlertDialogTrigger>
              }
            />
          </>
        )}
      </div>

      <AlertDialogContent className="w-11/12" onOpenAutoFocus={handleDeleteOpenAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {localize('com_ui_passkey_remove_confirm', { name: passkey.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {localize('com_ui_passkey_remove_description')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form onSubmit={submitDelete} className="flex flex-col gap-2">
          {showPasswordField && (
            <>
              <Label htmlFor={passwordFieldId} className="text-sm font-medium">
                {localize('com_ui_passkey_confirm_password')}
              </Label>
              <SecretInput
                id={passwordFieldId}
                ref={bindPasswordField}
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={hasPasswordError}
                aria-describedby={hasPasswordError ? passwordErrorId : undefined}
              />
              {hasPasswordError && (
                <p id={passwordErrorId} role="alert" className="text-text-destructive text-xs">
                  {localize('com_ui_passkey_password_incorrect')}
                </p>
              )}
            </>
          )}

          <AlertDialogFooter className="mt-2">
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline">
                {localize('com_ui_cancel')}
              </Button>
            </AlertDialogCancel>
            <Button
              type="submit"
              variant="destructive"
              disabled={isBusy || (showPasswordField && password === '')}
            >
              {isBusy ? <Spinner className="h-4 w-4" /> : localize('com_ui_delete')}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default React.memo(PasskeyItem);
