import { useRef, useState } from 'react';
import { useCreateAgentApiKeyMutation } from 'librechat-data-provider/react-query';
import { Button, Input, Label, Radio, Spinner, useToastContext } from '@librechat/client';
import type { TAgentApiKeyCreateResponse } from 'librechat-data-provider';
import type { FormEvent } from 'react';
import { computeExpiresAt, formatDate, DEFAULT_EXPIRY, EXPIRY_OPTIONS } from './utils';
import { useLocalize } from '~/hooks';

type CreateProps = {
  onCreated: (result: TAgentApiKeyCreateResponse) => void;
  onCancel: () => void;
};

export default function Create({ onCreated, onCancel }: CreateProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY);
  const inputRef = useRef<HTMLInputElement>(null);
  const createMutation = useCreateAgentApiKeyMutation();

  const expiresAt = computeExpiresAt(expiry);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (createMutation.isLoading) {
      return;
    }
    if (!name.trim()) {
      setNameError(true);
      inputRef.current?.focus();
      return;
    }
    try {
      const result = await createMutation.mutateAsync({
        name: name.trim(),
        expiresAt: computeExpiresAt(expiry),
      });
      onCreated(result);
    } catch {
      showToast({ message: localize('com_ui_api_key_create_error'), status: 'error' });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="api-key-name">{localize('com_ui_api_key_name')}</Label>
        <Input
          id="api-key-name"
          ref={inputRef}
          value={name}
          maxLength={100}
          aria-invalid={nameError}
          aria-describedby={nameError ? 'api-key-name-error' : undefined}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) {
              setNameError(false);
            }
          }}
          placeholder={localize('com_ui_api_key_name_placeholder')}
        />
        {nameError && (
          <p id="api-key-name-error" role="alert" className="text-xs text-text-destructive">
            {localize('com_ui_api_key_name_required')}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label id="api-key-expiry-label">{localize('com_ui_api_key_expiration')}</Label>
        <Radio
          fullWidth
          value={expiry}
          onChange={setExpiry}
          aria-labelledby="api-key-expiry-label"
          options={EXPIRY_OPTIONS.map(({ value, labelKey }) => ({
            value,
            label: localize(labelKey),
          }))}
        />
        <p className="text-xs text-text-secondary">
          {expiresAt == null
            ? localize('com_ui_api_key_no_expiration')
            : localize('com_ui_api_key_expires_on', { 0: formatDate(expiresAt) })}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={createMutation.isLoading}
        >
          {localize('com_ui_cancel')}
        </Button>
        <Button
          type="submit"
          variant="submit"
          disabled={createMutation.isLoading || !name.trim()}
          aria-busy={createMutation.isLoading}
          aria-label={localize('com_ui_create')}
        >
          {createMutation.isLoading ? <Spinner className="h-4 w-4" /> : localize('com_ui_create')}
        </Button>
      </div>
    </form>
  );
}
