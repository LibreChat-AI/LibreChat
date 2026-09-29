import { useState } from 'react';
import axios from 'axios';
import { RefreshCw } from 'lucide-react';
import { Button, Label } from '@librechat/client';
import type { TConfigReloadError, TConfigReloadResult } from 'librechat-data-provider';
import { useReloadCustomConfigMutation, useConfigReloadAccessQuery } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';

const SCOPE_LABELS = {
  cluster: 'com_ui_config_reload_cluster',
  local: 'com_ui_config_reload_local',
  unchanged: 'com_ui_config_reload_unchanged',
} as const;

const SECTION_LABELS = {
  applied_live: 'com_ui_config_reload_applied_live',
  restart_required: 'com_ui_config_reload_restart_required',
  unchanged: 'com_ui_config_reload_no_change',
} as const;

export default function ConfigReload() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { data: canReload } = useConfigReloadAccessQuery(user?.id);
  const mutation = useReloadCustomConfigMutation();
  const [report, setReport] = useState<TConfigReloadResult>();
  const [errorKey, setErrorKey] = useState<
    | 'com_ui_config_reload_conflict'
    | 'com_ui_config_reload_forbidden'
    | 'com_ui_config_reload_source_error'
    | 'com_ui_config_reload_failed'
  >();
  const [validationErrors, setValidationErrors] =
    useState<TConfigReloadError['validationErrors']>();

  if (canReload !== true) {
    return null;
  }

  const handleReload = () => {
    setReport(undefined);
    setErrorKey(undefined);
    setValidationErrors(undefined);
    mutation.mutate(undefined, {
      onSuccess: (result) => setReport(result),
      onError: (error: unknown) => {
        const response = axios.isAxiosError<TConfigReloadError>(error) ? error.response : undefined;
        const issues = response?.data?.validationErrors ?? [];
        setValidationErrors(issues);
        if (response?.status === 409) {
          setErrorKey('com_ui_config_reload_conflict');
          return;
        }
        if (response?.status === 403) {
          setErrorKey('com_ui_config_reload_forbidden');
          return;
        }
        if (response?.status === 400 && issues.length === 0) {
          setErrorKey('com_ui_config_reload_source_error');
          return;
        }
        setErrorKey('com_ui_config_reload_failed');
      },
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <Label id="config-reload-label">{localize('com_ui_config_reload_title')}</Label>
          <p className="text-sm text-text-secondary">
            {localize('com_ui_config_reload_description')}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          aria-labelledby="config-reload-label"
          disabled={mutation.isLoading}
          onClick={handleReload}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          {mutation.isLoading
            ? localize('com_ui_config_reload_loading')
            : localize('com_ui_config_reload_action')}
        </Button>
      </div>
      {errorKey && (
        <div role="alert" className="space-y-1 text-sm text-text-destructive">
          <p>{localize(errorKey)}</p>
          {validationErrors && validationErrors.length > 0 && (
            <ul className="list-inside list-disc">
              {validationErrors.map(({ path, message }, index) => (
                <li key={`${path.join('.')}-${index}`}>
                  {path.join('.')}: {message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {report && (
        <div aria-live="polite" className="space-y-2 text-sm">
          <p className="text-text-secondary">{localize(SCOPE_LABELS[report.scope])}</p>
          {report.propagationError && (
            <p role="alert" className="text-text-destructive">
              {localize('com_ui_config_reload_propagation_error')}
            </p>
          )}
          <ul className="max-h-48 divide-y divide-border-light overflow-auto rounded-lg border border-border-light">
            {report.sections.map(({ section, status, restartRequired, restartRequiredPaths }) => (
              <li
                key={section}
                className="flex flex-wrap items-start justify-between gap-2 px-3 py-2"
              >
                <span className="break-all text-text-primary">{section}</span>
                <span className="text-right text-text-secondary">
                  {localize(SECTION_LABELS[status])}
                  {restartRequired && status !== 'restart_required' && (
                    <span> · {localize('com_ui_config_reload_restart_required')}</span>
                  )}
                  {restartRequiredPaths && restartRequiredPaths.length > 0 && (
                    <span className="block break-all text-xs">
                      {restartRequiredPaths.join(', ')}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
