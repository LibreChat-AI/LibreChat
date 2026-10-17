import { useEffect, useId, useState } from 'react';
import { createCodeWorkerSetupCommand, isCodeWorkerShell } from 'librechat-data-provider';
import {
  Button,
  Chip,
  Input,
  Dropdown,
  Label,
  OGDialog,
  OGDialogTemplate,
  OGDialogTrigger,
  Spinner,
  useToastContext,
} from '@librechat/client';
import type {
  CodeEnvironmentPermissionDecision,
  TCodeEnvironmentSummary,
  CodeWorkerShell,
} from 'librechat-data-provider';
import type { CodeEnvironmentPairingResponse } from '~/data-provider/CodeEnvironments';
import {
  useCodeEnvironmentsQuery,
  useCodeEnvironmentStatusQuery,
  useDeleteCodeEnvironmentMutation,
  usePairCodeEnvironmentMutation,
  useUpdateCodeEnvironmentSettingsMutation,
} from '~/data-provider';
import { useLocalize } from '~/hooks';

const statusPresentation = {
  offline: { label: 'com_ui_code_environment_status_offline', tone: 'error' },
  starting: { label: 'com_ui_code_environment_status_starting', tone: 'warning' },
  ready: { label: 'com_ui_code_environment_status_ready', tone: 'success' },
} as const;

function EnvironmentStatus({ environmentId }: { environmentId: string }) {
  const localize = useLocalize();
  const query = useCodeEnvironmentStatusQuery(environmentId);
  if (query.isLoading) {
    return <Chip tone="neutral">{localize('com_ui_code_environment_status_checking')}</Chip>;
  }
  if (query.isError || query.data == null) {
    return <Chip tone="warning">{localize('com_ui_code_environment_status_unavailable')}</Chip>;
  }
  const presentation = statusPresentation[query.data.status];
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <Chip tone={presentation.tone}>{localize(presentation.label)}</Chip>
      {query.data.sandboxProfile != null && (
        <span className="text-text-tertiary max-w-48 truncate text-xs">
          {[query.data.sandboxProfile, ...(query.data.runtimes ?? [])].join(' · ')}
        </span>
      )}
    </div>
  );
}

function WorkerCommand({ pairing }: { pairing: CodeEnvironmentPairingResponse['pairing'] }) {
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const [shell, setShell] = useState<CodeWorkerShell>('posix');
  const command = createCodeWorkerSetupCommand(pairing, shell, {
    allowWorkspaceWrites: true,
    allowWorkspaceCommands: true,
  });
  return (
    <div className="border-border-medium bg-surface-secondary flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-text-primary text-sm font-medium">
          {localize('com_ui_code_environment_pairing_ready')}
        </p>
        <Dropdown
          value={shell}
          options={[
            { value: 'posix', label: localize('com_ui_code_environment_shell_posix') },
            { value: 'powershell', label: localize('com_ui_code_environment_shell_powershell') },
          ]}
          onChange={(value) => {
            if (isCodeWorkerShell(value)) {
              setShell(value);
            }
          }}
          ariaLabel={localize('com_ui_code_environment_shell')}
          testId="code-environment-shell"
          className="shrink-0"
          sizeClasses="z-50 min-w-48"
        />
      </div>
      <p className="text-text-secondary text-xs">
        {localize('com_ui_code_environment_pairing_description')}
      </p>
      <pre className="bg-surface-tertiary text-text-primary overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap">
        {command}
      </pre>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            showToast({ message: localize('com_ui_copied_to_clipboard'), status: 'success' });
          } catch {
            showToast({ message: localize('com_ui_copy_failed'), status: 'error' });
          }
        }}
      >
        {localize('com_ui_copy_to_clipboard')}
      </Button>
    </div>
  );
}

const permissionLabels = {
  allow: 'com_ui_code_environment_permission_allow',
  ask: 'com_ui_code_environment_permission_ask',
  deny: 'com_ui_code_environment_permission_deny',
} as const;

function effectivePermission(
  field: NonNullable<
    NonNullable<NonNullable<TCodeEnvironmentSummary['configSchema']>['permissions']>['fileWrite']
  >,
  configured: CodeEnvironmentPermissionDecision | undefined,
): CodeEnvironmentPermissionDecision {
  return configured != null && field.allowed.includes(configured) ? configured : field.default;
}

function EnvironmentPermissions({ environment }: { environment: TCodeEnvironmentSummary }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const updateMutation = useUpdateCodeEnvironmentSettingsMutation();
  const idPrefix = useId();
  const fields = environment.configSchema?.permissions;
  if (fields == null || !environment.canEdit) return null;

  const updatePermission = (
    category: 'fileWrite' | 'commandExecution',
    value: CodeEnvironmentPermissionDecision,
  ) => {
    updateMutation.mutate(
      { id: environment.id, settings: { permissions: { [category]: value } } },
      {
        onSuccess: () =>
          showToast({
            message: localize('com_ui_code_environment_permissions_saved'),
            status: 'success',
          }),
        onError: () =>
          showToast({
            message: localize('com_ui_code_environment_permissions_error'),
            status: 'error',
          }),
      },
    );
  };

  const controls = [
    {
      category: 'fileWrite' as const,
      label: 'com_ui_code_environment_file_write' as const,
      field: fields.fileWrite,
    },
    {
      category: 'commandExecution' as const,
      label: 'com_ui_code_environment_command_execution' as const,
      field: fields.commandExecution,
    },
  ].filter((control) => control.field != null);

  return (
    <div className="border-border-light mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2">
      {controls.map(({ category, label, field }) => {
        if (field == null) return null;
        const value = effectivePermission(field, environment.settings?.permissions?.[category]);
        return (
          <div key={category} className="flex flex-col gap-1.5">
            <div id={`${idPrefix}-${category}`} className="text-text-primary text-sm font-medium">
              {localize(label)}
            </div>
            <Dropdown
              value={value}
              options={field.allowed.map((decision) => ({
                value: decision,
                label: localize(permissionLabels[decision]),
              }))}
              disabled={updateMutation.isLoading}
              onChange={(decision) =>
                updatePermission(category, decision as CodeEnvironmentPermissionDecision)
              }
              aria-labelledby={`${idPrefix}-${category}`}
              testId={`code-environment-${category}`}
              variant="field"
              sizeClasses="z-50 min-w-48"
            />
          </div>
        );
      })}
    </div>
  );
}

export default function CodeEnvironments() {
  const localize = useLocalize();
  const nameId = useId();
  const planeId = useId();
  const { showToast } = useToastContext();
  const query = useCodeEnvironmentsQuery();
  const pairMutation = usePairCodeEnvironmentMutation();
  const deleteMutation = useDeleteCodeEnvironmentMutation();
  const [name, setName] = useState('');
  const [controlPlaneId, setControlPlaneId] = useState('');
  const [pairing, setPairing] = useState<CodeEnvironmentPairingResponse['pairing']>();
  const controlPlanes = query.data?.controlPlanes ?? [];
  const selectedControlPlane = controlPlaneId || controlPlanes[0]?.id || '';

  useEffect(() => {
    if (pairing == null) return;
    const remaining = Date.parse(pairing.expiresAt) - Date.now();
    const delay = Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
    const timeout = window.setTimeout(() => setPairing(undefined), delay);
    return () => window.clearTimeout(timeout);
  }, [pairing]);

  const pair = () => {
    const trimmedName = name.trim();
    if (!trimmedName || !selectedControlPlane) return;
    pairMutation.mutate(
      { name: trimmedName, controlPlaneId: selectedControlPlane },
      {
        onSuccess: (result) => {
          setName('');
          setPairing(result.pairing);
          showToast({
            message: localize('com_ui_code_environment_pairing_created'),
            status: 'success',
          });
        },
        onError: () =>
          showToast({
            message: localize('com_ui_code_environment_pairing_error'),
            status: 'error',
          }),
      },
    );
  };

  let pairingControls = (
    <p className="text-text-secondary text-sm">{localize('com_ui_code_environment_unavailable')}</p>
  );
  if (query.isLoading) {
    pairingControls = (
      <div className="text-text-secondary flex items-center gap-2 text-sm">
        <Spinner />
        {localize('com_ui_loading')}
      </div>
    );
  } else if (query.isError) {
    pairingControls = (
      <p className="text-text-destructive text-sm">
        {localize('com_ui_code_environment_load_error')}
      </p>
    );
  } else if (controlPlanes.length > 0) {
    pairingControls = (
      <form
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          pair();
        }}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={nameId}>{localize('com_ui_name')}</Label>
          <Input
            id={nameId}
            value={name}
            maxLength={100}
            placeholder={localize('com_ui_code_environment_name_placeholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div id={planeId} className="text-text-primary text-sm font-medium">
            {localize('com_ui_code_environment_control_plane')}
          </div>
          <Dropdown
            value={selectedControlPlane}
            options={controlPlanes.map((controlPlane) => ({
              value: controlPlane.id,
              label: controlPlane.name,
            }))}
            onChange={setControlPlaneId}
            aria-labelledby={planeId}
            testId="code-environment-control-plane"
            variant="field"
            sizeClasses="z-50 min-w-48"
          />
        </div>
        <Button type="submit" disabled={!name.trim() || pairMutation.isLoading}>
          {pairMutation.isLoading ? <Spinner /> : localize('com_ui_code_environment_pair')}
        </Button>
      </form>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div>
        <h3 className="text-text-primary text-sm font-medium">
          {localize('com_ui_code_environments')}
        </h3>
        <p className="text-text-secondary mt-1 text-xs">
          {localize('com_ui_code_environments_description')}
        </p>
      </div>

      {pairingControls}

      {pairing != null && <WorkerCommand pairing={pairing} />}

      <div className="flex flex-col gap-2">
        {(query.data?.environments ?? []).map((environment) => (
          <div key={environment.id} className="border-border-medium rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-text-primary truncate text-sm font-medium">{environment.name}</p>
                <p className="text-text-secondary truncate text-xs">{environment.id}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <EnvironmentStatus environmentId={environment.id} />
                {environment.canDelete && (
                  <OGDialog>
                    <OGDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={localize('com_ui_delete_var', { 0: environment.name })}
                      >
                        {localize('com_ui_delete')}
                      </Button>
                    </OGDialogTrigger>
                    <OGDialogTemplate
                      className="max-w-md"
                      showCloseButton={false}
                      title={localize('com_ui_code_environment_remove_title')}
                      main={
                        <p className="text-text-secondary text-sm">
                          {localize('com_ui_code_environment_remove_description')}
                        </p>
                      }
                      selection={{
                        selectHandler: () =>
                          deleteMutation.mutate(environment.id, {
                            onSuccess: () =>
                              showToast({
                                message: localize('com_ui_code_environment_removed'),
                                status: 'success',
                              }),
                            onError: () =>
                              showToast({
                                message: localize('com_ui_code_environment_remove_error'),
                                status: 'error',
                              }),
                          }),
                        selectClasses:
                          'bg-surface-destructive text-text-on-status transition-all duration-200 hover:bg-surface-destructive-hover',
                        selectText: localize('com_ui_delete'),
                      }}
                    />
                  </OGDialog>
                )}
              </div>
            </div>
            <EnvironmentPermissions environment={environment} />
          </div>
        ))}
      </div>
    </div>
  );
}
