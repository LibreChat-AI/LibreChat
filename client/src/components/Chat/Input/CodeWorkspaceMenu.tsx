import { Fragment, useId, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { isCodeWorkspaceCheckoutAvailable } from 'librechat-data-provider';
import { TooltipAnchor, composerControlClasses, useToastContext } from '@librechat/client';
import { Check, ChevronDown, Folder, FolderSync, FolderX, RefreshCw, Monitor } from 'lucide-react';
import type { CodeWorkspaceSelection, TConversation } from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import type {
  CodeWorkspaceEnvironmentResult,
  CodeWorkspaceResult,
  CodeWorkspaceTransition,
  TranslationKeys,
} from '~/hooks';
import {
  useCodeWorkspaceRefresh,
  useMoveConversationCodeEnvironmentMutation,
  useReconcileConversationCodeEnvironmentMutation,
  useCodeEnvironmentStatusQueries,
} from '~/data-provider';
import {
  cn,
  codeWorkspaceErrorKeys,
  getCodeWorkspaceErrorReason,
  getResponseStatus,
} from '~/utils';
import { useLocalize } from '~/hooks';

const stateLabels: Partial<Record<CodeWorkspaceResult['state'], TranslationKeys>> = {
  not_required: 'com_ui_code_workspace',
  loading: 'com_ui_code_workspace_loading',
  choose: 'com_ui_code_workspace_choose',
  missing: 'com_ui_code_workspace_missing',
  unavailable: 'com_ui_code_workspace_unavailable',
  unsupported: 'com_ui_code_workspace_unsupported',
  without_attached: 'com_ui_code_workspace_without_attached',
};

const headingClasses = 'px-2.5 py-1.5 text-xs font-medium text-text-secondary';

const menuItemClasses = (selected = false) =>
  cn(
    'group flex w-full cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2',
    'outline-hidden transition-colors duration-theme-fast',
    'hover:bg-surface-hover data-[active-item]:bg-surface-hover',
    selected && 'bg-surface-active-alt',
  );

/** Conflicts refresh the decision; definitive rejections keep their specific explanation. */
function transitionErrorKey(error: unknown): TranslationKeys {
  const reason = getCodeWorkspaceErrorReason(error);
  if (reason === 'locked') return 'com_ui_code_workspace_move_stale';
  if (reason != null) return codeWorkspaceErrorKeys[reason];
  if (getResponseStatus(error) === 409) return 'com_ui_code_workspace_move_busy';
  return 'com_ui_code_workspace_move_error';
}

function describeTransition(
  transition: CodeWorkspaceTransition,
  localize: ReturnType<typeof useLocalize>,
): { label: string; info: string } {
  if (transition.kind === 'detach') {
    return {
      label: localize('com_ui_code_workspace_detach'),
      info: localize('com_ui_code_workspace_detach_info'),
    };
  }
  if (transition.targets.some(({ state }) => state === 'missing')) {
    return {
      label: localize('com_ui_code_workspace_recover'),
      info: localize('com_ui_code_workspace_recover_info'),
    };
  }
  const targetNames = transition.targets
    .map(({ environment }) => environment.name ?? environment.id)
    .join(', ');
  if (transition.kind === 'attach') {
    return {
      label:
        transition.targets.length === 1
          ? localize('com_ui_code_workspace_attach_to', { 0: targetNames })
          : localize('com_ui_code_workspace_attach'),
      info: localize('com_ui_code_workspace_attach_info'),
    };
  }
  const previousNames = transition.previous.map(({ id, name }) => name ?? id).join(', ');
  let info = localize('com_ui_code_workspace_move_info', { 0: previousNames, 1: targetNames });
  if (transition.targets.length === 0 && !previousNames) {
    /** Nothing to move onto and nothing the agents dropped: the machine itself is the problem. */
    info = localize('com_ui_code_workspace_detach_prompt');
  } else if (transition.targets.length === 0) {
    info = localize('com_ui_code_workspace_move_info_removed', { 0: previousNames });
  } else if (!previousNames) {
    info = localize('com_ui_code_workspace_move_info_added', { 0: targetNames });
  }
  return {
    label:
      transition.targets.length === 1
        ? localize('com_ui_code_workspace_move_to', { 0: targetNames })
        : localize('com_ui_code_workspace_move'),
    info,
  };
}

/** A sole advertised workspace is the only valid pick, so it counts as chosen until changed. */
function chosenWorkspaceId(
  target: CodeWorkspaceEnvironmentResult,
  choices: Record<string, CodeWorkspaceSelection>,
): string | undefined {
  const choice = choices[target.environment.id];
  if (choice != null && target.workspaces.some(({ id }) => id === choice.workspaceId))
    return choice.workspaceId;
  return target.workspaces.length === 1 ? target.workspaces[0].id : undefined;
}

function EnvironmentWorkspaces({
  environment,
  requiredBy,
  workspaces,
  emptyLabel,
  hideOnClick,
  isSelected,
  onSelect,
  checkout,
  allowCheckoutSelection = false,
}: {
  environment: CodeWorkspaceEnvironmentResult['environment'];
  requiredBy?: CodeWorkspaceEnvironmentResult['requiredBy'];
  workspaces: CodeWorkspaceEnvironmentResult['workspaces'];
  emptyLabel: string;
  hideOnClick: boolean;
  isSelected: (workspaceId: string) => boolean;
  onSelect: (selection: CodeWorkspaceSelection) => void;
  checkout?: CodeWorkspaceSelection['checkout'];
  allowCheckoutSelection?: boolean;
}) {
  const localize = useLocalize();
  return (
    <div data-code-environment-id={environment.id}>
      <Ariakit.MenuHeading render={<div />} className={headingClasses}>
        {environment.name ?? environment.id}
      </Ariakit.MenuHeading>
      {requiredBy != null && requiredBy.length > 0 && (
        <p className="text-text-secondary px-2.5 pb-2 text-xs">
          {localize('com_ui_code_workspace_used_by', {
            0: requiredBy.map(({ id, name }) => name || id).join(', '),
          })}
        </p>
      )}
      {workspaces.length === 0 && (
        <div className="text-text-secondary px-2.5 py-2 text-sm">{emptyLabel}</div>
      )}
      {workspaces.map((descriptor) => {
        const selected = isSelected(descriptor.id);
        return (
          <Fragment key={descriptor.id}>
            <Ariakit.MenuItemRadio
              key={descriptor.id}
              name={`codeWorkspace:${environment.id}`}
              value={descriptor.id}
              checked={selected}
              hideOnClick={hideOnClick}
              onChange={() =>
                onSelect({ environmentId: environment.id, workspaceId: descriptor.id })
              }
              className={menuItemClasses(selected)}
            >
              <Folder className="text-text-secondary mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1 text-left">
                <div className="text-text-primary truncate text-sm font-medium">
                  {descriptor.name ?? descriptor.id}
                </div>
                {descriptor.name && (
                  <p className="text-text-secondary truncate text-xs">{descriptor.id}</p>
                )}
                {descriptor.instructions !== undefined && (
                  <p className="text-text-secondary truncate text-xs">
                    {descriptor.instructions.length === 0
                      ? localize('com_ui_repository_instructions_none')
                      : descriptor.instructions
                          .map(
                            (file) =>
                              `${file.path} · ${(file.bytes / 1024).toFixed(1)} KB${file.truncated ? ` · ${localize('com_ui_repository_instructions_truncated')}` : ''}`,
                          )
                          .join(', ')}
                  </p>
                )}
                {(descriptor.environment?.repo || descriptor.environment?.ref) && (
                  <p className="text-text-secondary truncate text-xs">
                    {[descriptor.environment.repo, descriptor.environment.ref]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </div>
              {selected && (
                <Check className="text-text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
              )}
            </Ariakit.MenuItemRadio>
            {selected &&
              allowCheckoutSelection &&
              environment.configSchema?.workspaces?.allowCheckoutSelection === true && (
                <>
                  <Ariakit.MenuHeading render={<div />} className={headingClasses}>
                    {localize('com_ui_code_checkout_mode')}
                  </Ariakit.MenuHeading>
                  {(['isolated', 'source'] as const)
                    .filter(
                      (mode) =>
                        mode === 'source' ||
                        descriptor.workspaceInstances?.includes('git_worktree'),
                    )
                    .map((mode) => (
                      <Ariakit.MenuItemRadio
                        key={mode}
                        name={`codeCheckout:${environment.id}`}
                        value={mode}
                        checked={checkout === mode}
                        hideOnClick={hideOnClick}
                        className={menuItemClasses(checkout === mode)}
                        onChange={() =>
                          onSelect({
                            environmentId: environment.id,
                            workspaceId: descriptor.id,
                            checkout: mode,
                          })
                        }
                      >
                        <div className="min-w-0 flex-1 text-left">
                          <div className="text-text-primary text-sm font-medium">
                            {localize(
                              mode === 'isolated'
                                ? 'com_ui_code_checkout_isolated'
                                : 'com_ui_code_checkout_source',
                            )}
                          </div>
                          <p className="text-text-secondary text-xs">
                            {localize(
                              mode === 'isolated'
                                ? 'com_ui_code_checkout_isolated_info'
                                : 'com_ui_code_checkout_source_info',
                            )}
                          </p>
                        </div>
                        {checkout === mode && (
                          <Check
                            className="text-text-primary mt-0.5 size-4 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                      </Ariakit.MenuItemRadio>
                    ))}
                </>
              )}
          </Fragment>
        );
      })}
    </div>
  );
}

function WorkspaceRequirements({ id, requirements }: { id: string; requirements: string[] }) {
  if (requirements.length === 0) return null;
  return (
    <div id={id} role="status" aria-live="polite" className="text-text-secondary text-xs">
      {requirements.map((requirement) => (
        <p key={requirement}>{requirement}</p>
      ))}
    </div>
  );
}

export default function CodeWorkspaceMenu({
  setConversation,
  workspace,
  disabled,
}: {
  setConversation: SetterOrUpdater<TConversation | null>;
  workspace: CodeWorkspaceResult;
  disabled: boolean;
}) {
  const requirementsId = useId();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const menuStore = Ariakit.useMenuStore({ focusLoop: true, placement: 'top-start' });
  const isOpen = menuStore.useState('open');
  const [machineId, setMachineId] = useState<string | null>(null);
  const machine = workspace.machineOptions?.find(
    ({ id }) =>
      id === machineId && !workspace.environments.some(({ environment }) => environment.id === id),
  );
  const machineQueries = useCodeEnvironmentStatusQueries(
    machine ? [machine.id] : [],
    isOpen && machine != null && !workspace.locked,
  );
  const machineQuery = machineQueries[0];
  const machineStatus = machineQuery?.data;
  const machineReady =
    machine != null &&
    machineStatus?.environmentId === machine.id &&
    machineStatus.status === 'ready' &&
    machineStatus.workspaces != null &&
    machineStatus.operations != null;
  const moveMutation = useMoveConversationCodeEnvironmentMutation(setConversation);
  const reconcileMutation = useReconcileConversationCodeEnvironmentMutation(setConversation);
  const { refresh, isRefreshing } = useCodeWorkspaceRefresh();
  const [moveDraft, setMoveDraft] = useState<{
    conversationId: string;
    workspaces: Record<string, CodeWorkspaceSelection>;
  } | null>(null);

  if (!workspace.visible) return null;

  if (workspace.recovery != null) {
    const { request, status } = workspace.recovery;
    const pending = status === 'pending';
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span role="status" className="text-text-secondary text-xs">
          {localize(
            pending
              ? 'com_ui_code_workspace_reconciling'
              : 'com_ui_code_workspace_reconcile_failed',
          )}
        </span>
        <button
          type="button"
          className={composerControlClasses()}
          disabled={disabled || pending || reconcileMutation.isLoading}
          onClick={() => reconcileMutation.mutate(request)}
        >
          {localize('com_ui_code_workspace_reconcile_retry')}
        </button>
      </div>
    );
  }

  const { transition } = workspace;
  const environmentIds = new Set(workspace.environments.map(({ environment }) => environment.id));
  const selectWorkspace = (selection: CodeWorkspaceSelection) => {
    const previous = workspace.environments.find(
      ({ environment }) => environment.id === selection.environmentId,
    )?.selected;
    if (selection.checkout == null && previous?.checkout != null) {
      selection = { ...selection, checkout: previous.checkout };
    }
    workspace.rememberSelection(selection);
    const replacedIds = new Set(
      workspace.machineOptionGroups?.filter((ids) => ids.includes(selection.environmentId)).flat(),
    );
    const owners = workspace.machineChoiceOwners
      ?.filter(({ environmentIds }) => environmentIds.includes(selection.environmentId))
      .map(({ agentId }) => agentId);
    setConversation((current) => {
      if (current == null) return current;
      const retained = (current.codeWorkspaces ?? workspace.selections ?? []).flatMap(
        ({ agentIds, ...existing }) => {
          if (
            !environmentIds.has(existing.environmentId) ||
            existing.environmentId === selection.environmentId
          )
            return [];
          const remaining = agentIds?.filter((id) => !owners?.includes(id));
          const fixed = workspace.fixedMachineIds?.includes(existing.environmentId);
          if (
            !fixed &&
            (agentIds == null ? replacedIds.has(existing.environmentId) : remaining?.length === 0)
          )
            return [];
          return [{ ...existing, ...(remaining?.length ? { agentIds: remaining } : {}) }];
        },
      );
      return {
        ...current,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [
          ...retained,
          { ...selection, ...(owners?.length ? { agentIds: owners } : {}) },
        ].sort((a, b) => a.environmentId.localeCompare(b.environmentId)),
      };
    });
  };
  const selectWithoutAttached = () => {
    setConversation((current) =>
      current == null
        ? current
        : {
            ...current,
            codeEnvironmentMode: 'without_attached',
            codeWorkspaces: undefined,
          },
    );
  };
  const transitionText = transition == null ? null : describeTransition(transition, localize);
  /** Choices belong to the chat they were made in; another transitionable chat starts undecided. */
  const moveChoices =
    transition != null && moveDraft?.conversationId === transition.conversationId
      ? moveDraft.workspaces
      : {};
  /** Every target needs a workspace, so the whole transition lands in one validated write. */
  const chosenTargets =
    transition?.targets.flatMap((target) => {
      const workspaceId = chosenWorkspaceId(target, moveChoices);
      const previous = transition.from?.filter(
        ({ environmentId, agentIds }) =>
          environmentId === target.environment.id ||
          agentIds?.some((id) => target.selectionOwners?.includes(id)),
      );
      const priorModes = new Set(
        (previous?.length ? previous : (transition.from ?? [])).map(({ checkout }) => checkout),
      );
      const inheritedCheckout = priorModes.size === 1 ? [...priorModes][0] : undefined;
      /** A mixed predecessor decision requires a deliberate mode, never an automatic fallback. */
      return workspaceId == null ||
        (priorModes.size > 1 && moveChoices[target.environment.id]?.checkout == null)
        ? []
        : [
            {
              environmentId: target.environment.id,
              workspaceId,
              checkout: moveChoices[target.environment.id]?.checkout ?? inheritedCheckout,
              ...(target.selectionOwners?.length ? { agentIds: target.selectionOwners } : {}),
            },
          ];
    }) ?? [];
  /** A transition replaces the whole decision, so an empty target set is the detach and gets its
   *  own item: this one only confirms a decision that still names at least one workspace. */
  const proposed = transition == null ? [] : [...transition.retained, ...chosenTargets];
  const offersMove =
    transition != null &&
    transition.kind !== 'detach' &&
    (transition.targets.length > 0 || transition.retained.length > 0);
  const moveReady =
    transition != null &&
    chosenTargets.length === transition.targets.length &&
    proposed.length > 0 &&
    chosenTargets.every((selection) => {
      const target = transition.targets.find(
        ({ environment }) => environment.id === selection.environmentId,
      );
      return isCodeWorkspaceCheckoutAvailable(
        selection,
        target?.workspaces.find(({ id }) => id === selection.workspaceId),
        target?.environment.configSchema?.workspaces?.allowCheckoutSelection === true,
      );
    });
  const applyTransition = (to: CodeWorkspaceSelection[]) => {
    if (transition == null || disabled || moveMutation.isLoading) return;
    moveMutation.mutate(
      { conversationId: transition.conversationId, from: transition.from, to },
      {
        onSuccess: () => {
          to.forEach((selection) => workspace.rememberSelection(selection));
          setMoveDraft(null);
        },
        onError: (error) => {
          showToast({ message: localize(transitionErrorKey(error)), status: 'error' });
        },
      },
    );
  };
  const confirmMove = () => {
    if (!moveReady) return;
    applyTransition(proposed);
  };
  /** An empty target set is the detach: the chat keeps its history and continues without a
   *  workspace, instead of waiting on a machine it cannot reach. */
  const confirmDetach = () => applyTransition([]);
  const onlyEnvironment = workspace.environments.length === 1 ? workspace.environments[0] : null;
  const onlyDescriptor = onlyEnvironment?.workspaces.find(
    ({ id }) => id === onlyEnvironment.selected?.workspaceId,
  );
  const labelKey = stateLabels[workspace.state];
  let label =
    workspace.state === 'without_attached'
      ? localize('com_ui_code_workspace_without_attached')
      : (onlyDescriptor?.name ?? onlyDescriptor?.id);
  if (label == null && workspace.state === 'ready') {
    label = localize('com_ui_code_workspaces_selected', {
      0: workspace.selections?.length ?? 0,
    });
  } else if (label == null) {
    label = labelKey ? localize(labelKey) : localize('com_ui_code_workspace_choose');
  }
  if (onlyDescriptor && (workspace.machineOptions?.length ?? 0) > 1) {
    label = `${onlyEnvironment?.environment.name ?? onlyEnvironment?.environment.id} · ${label}`;
  }
  if (onlyEnvironment?.selected?.checkout != null) {
    label = `${label} · ${localize(onlyEnvironment.selected.checkout === 'isolated' ? 'com_ui_code_checkout_isolated' : 'com_ui_code_checkout_source')}`;
  }
  const checkoutSummaries = workspace.environments.flatMap(
    ({ environment, selected, workspaces }) => {
      if (selected?.checkout == null) return [];
      const descriptor = workspaces.find(({ id }) => id === selected.workspaceId);
      return [
        `${environment.name ?? environment.id} · ${descriptor?.name ?? selected.workspaceId} · ${localize(selected.checkout === 'isolated' ? 'com_ui_code_checkout_isolated' : 'com_ui_code_checkout_source')}`,
      ];
    },
  );
  const Icon =
    workspace.mode === 'without_attached' ||
    workspace.state === 'missing' ||
    workspace.state === 'unavailable'
      ? FolderX
      : Folder;
  const pendingRequirements =
    workspace.state === 'without_attached'
      ? []
      : workspace.environments.flatMap(({ environment, state, requiredBy }) => {
          if (state === 'ready' || !requiredBy?.length) return [];
          const agents = requiredBy.map(({ id, name }) => name || id).join(', ');
          return [
            state === 'choose'
              ? localize('com_ui_code_workspace_required_for', {
                  0: agents,
                  1: environment.name ?? environment.id,
                })
              : localize('com_ui_code_workspace_agent_status', {
                  0: agents,
                  1: environment.name ?? environment.id,
                  2: localize(stateLabels[state] ?? 'com_ui_code_workspace_unavailable'),
                }),
          ];
        });
  const requirements =
    pendingRequirements.length === 0 && workspace.state === 'choose' && !workspace.canSubmit
      ? [localize('com_ui_code_workspace_graph_selection_conflict')]
      : pendingRequirements;
  if (
    requirements.length > 0 &&
    new Set(
      workspace.environments.flatMap(({ requiredBy }) => requiredBy?.map(({ id }) => id) ?? []),
    ).size > 1
  ) {
    requirements.unshift(localize('com_ui_code_workspace_graph_requirement'));
  }

  if (workspace.locked && transition == null) {
    /** A sealed decision with no transition on offer only reports where this chat runs: without a
     *  workspace by its own recorded choice, or on a machine that needs attention. Whether that is
     *  worth showing at all is `visible`, above. */
    const recovery =
      workspace.mode === 'without_attached'
        ? localize('com_ui_code_workspace_without_attached_info')
        : localize('com_ui_code_workspace_locked_recovery');
    return (
      <div className="flex min-w-0 flex-col items-start gap-1">
        <TooltipAnchor
          description={requirements.join(' ') || recovery}
          render={
            <button
              type="button"
              data-testid="code-workspace-locked-status"
              disabled={disabled || isRefreshing}
              onClick={() => void refresh()}
              aria-label={`${label}. ${recovery}. ${localize('com_ui_retry')}`}
              aria-describedby={requirements.length > 0 ? requirementsId : undefined}
              aria-busy={isRefreshing}
              className={cn(composerControlClasses(), 'max-w-full min-w-0 px-2.5')}
            />
          }
        >
          <Icon className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
          <span role="status" className="max-w-[16rem] min-w-0 truncate">
            {label}
          </span>
          <RefreshCw className="text-text-secondary size-3 shrink-0" aria-hidden="true" />
        </TooltipAnchor>
        <WorkspaceRequirements id={requirementsId} requirements={requirements} />
        {workspace.environments.length > 1 && (
          <WorkspaceRequirements
            id={`${requirementsId}-checkouts`}
            requirements={checkoutSummaries}
          />
        )}
      </div>
    );
  }

  const buttonDisabled = disabled || moveMutation.isLoading;
  /** Only a move renames the control, because it replaces the machine the chat already runs on.
   *  Attaching and detaching keep naming the current state, which is what their menu changes. */
  const renamesForMove = transition?.kind === 'move' && offersMove && transitionText != null;
  const ButtonIcon = renamesForMove ? FolderSync : Icon;
  const ConfirmIcon = transition?.kind === 'attach' ? Folder : FolderSync;
  const buttonLabel = renamesForMove ? transitionText.label : label;

  return (
    <Ariakit.MenuProvider store={menuStore}>
      <div className="flex min-w-0 flex-col items-start gap-1">
        <TooltipAnchor
          description={
            transitionText?.info ?? (requirements.join(' ') || localize('com_ui_code_workspace'))
          }
          disabled={isOpen}
          render={
            <Ariakit.MenuButton
              disabled={buttonDisabled}
              data-testid={renamesForMove ? 'code-workspace-move' : 'code-workspace'}
              aria-describedby={requirements.length > 0 ? requirementsId : undefined}
              aria-label={
                transitionText == null
                  ? `${localize('com_ui_code_workspace')}: ${label}`
                  : `${buttonLabel}. ${transitionText.info}`
              }
              className={cn(
                composerControlClasses(),
                'md:px-theme-control-x max-w-full min-w-0 px-2.5',
                isOpen && 'bg-surface-hover',
                buttonDisabled && 'cursor-not-allowed opacity-50',
              )}
            />
          }
        >
          <ButtonIcon className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
          <span className="max-w-[12rem] min-w-0 truncate">{buttonLabel}</span>
          <ChevronDown
            className={cn(
              'text-text-secondary size-3 shrink-0 transition-transform',
              isOpen && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </TooltipAnchor>
        <WorkspaceRequirements id={requirementsId} requirements={requirements} />
      </div>
      <Ariakit.Menu
        portal={true}
        gutter={8}
        unmountOnHide={true}
        className={cn(
          'z-50 flex max-w-[min(360px,calc(100vw-2rem))] min-w-[280px] flex-col rounded-xl',
          'border-border-light bg-presentation max-h-[var(--popover-available-height)] overflow-y-auto border p-1.5 shadow-lg',
          'origin-bottom opacity-0 transition-[opacity,transform] duration-200 ease-out',
          'data-[enter]:scale-100 data-[enter]:opacity-100',
          'scale-95 data-[leave]:scale-95 data-[leave]:opacity-0',
        )}
      >
        {transition != null && transitionText != null ? (
          <>
            <Ariakit.MenuHeading render={<div />} className={headingClasses}>
              {transitionText.label}
            </Ariakit.MenuHeading>
            <p className="text-text-secondary px-2.5 pb-2 text-xs">{transitionText.info}</p>
            {transition.targets.map((target) => (
              <EnvironmentWorkspaces
                key={target.environment.id}
                environment={target.environment}
                requiredBy={target.requiredBy}
                workspaces={target.workspaces}
                emptyLabel={localize('com_ui_code_workspace_unavailable')}
                hideOnClick={false}
                isSelected={(workspaceId) => chosenWorkspaceId(target, moveChoices) === workspaceId}
                allowCheckoutSelection={true}
                checkout={
                  chosenTargets.find(({ environmentId }) => environmentId === target.environment.id)
                    ?.checkout
                }
                onSelect={(selection) =>
                  setMoveDraft({
                    conversationId: transition.conversationId,
                    workspaces: {
                      ...moveChoices,
                      [selection.environmentId]: {
                        ...selection,
                        checkout:
                          selection.checkout ??
                          chosenTargets.find(
                            ({ environmentId }) => environmentId === selection.environmentId,
                          )?.checkout,
                      },
                    },
                  })
                }
              />
            ))}
            <Ariakit.MenuSeparator className="border-border-light my-1 h-0 w-full border-t" />
            {offersMove && (
              <Ariakit.MenuItem
                disabled={disabled || !moveReady || moveMutation.isLoading}
                hideOnClick={true}
                onClick={confirmMove}
                className={cn(
                  menuItemClasses(),
                  'items-center aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
                )}
              >
                <ConfirmIcon className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
                <span className="text-text-primary min-w-0 flex-1 truncate text-left text-sm font-medium">
                  {transitionText.label}
                </span>
              </Ariakit.MenuItem>
            )}
            {transition.detachable && (
              <Ariakit.MenuItem
                data-testid="code-workspace-detach"
                disabled={disabled || moveMutation.isLoading}
                hideOnClick={true}
                onClick={confirmDetach}
                className={cn(
                  menuItemClasses(),
                  'aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
                )}
              >
                <FolderX
                  className="text-text-secondary mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 text-left">
                  <div className="text-text-primary truncate text-sm font-medium">
                    {localize('com_ui_code_workspace_detach')}
                  </div>
                  <p className="text-text-secondary text-xs">
                    {localize('com_ui_code_workspace_detach_info')}
                  </p>
                </div>
              </Ariakit.MenuItem>
            )}
          </>
        ) : (
          <>
            <Ariakit.MenuHeading render={<div />} className={headingClasses}>
              {localize('com_ui_code_environment')}
            </Ariakit.MenuHeading>
            {workspace.supportsEnvironmentDecisions && (
              <Ariakit.MenuItemRadio
                name="codeEnvironmentMode"
                value="without_attached"
                checked={workspace.mode === 'without_attached'}
                hideOnClick={true}
                onChange={selectWithoutAttached}
                className={menuItemClasses(workspace.mode === 'without_attached')}
              >
                <FolderX
                  className="text-text-secondary mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 text-left">
                  <div className="text-text-primary truncate text-sm font-medium">
                    {localize('com_ui_code_workspace_without_attached')}
                  </div>
                  <p className="text-text-secondary text-xs">
                    {localize('com_ui_code_workspace_without_attached_info')}
                  </p>
                </div>
                {workspace.mode === 'without_attached' && (
                  <Check className="text-text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
                )}
              </Ariakit.MenuItemRadio>
            )}
            {workspace.environments.map(
              ({ environment, state, workspaces, selected, requiredBy }) => (
                <EnvironmentWorkspaces
                  key={environment.id}
                  environment={environment}
                  requiredBy={requiredBy}
                  workspaces={workspaces}
                  emptyLabel={localize(stateLabels[state] ?? 'com_ui_code_workspace_unavailable')}
                  hideOnClick={true}
                  isSelected={(workspaceId) =>
                    workspace.mode === 'attached' && workspaceId === selected?.workspaceId
                  }
                  onSelect={selectWorkspace}
                  checkout={selected?.checkout}
                  allowCheckoutSelection={!workspace.locked}
                />
              ),
            )}
            {workspace.machineOptions?.some(({ id }) => !environmentIds.has(id)) && (
              <>
                <Ariakit.MenuSeparator className="border-border-light my-1 h-0 w-full border-t" />
                <Ariakit.MenuHeading render={<div />} className={headingClasses}>
                  {localize('com_ui_code_environment_choose_machine')}
                </Ariakit.MenuHeading>
                {workspace.machineOptions
                  ?.filter(({ id }) => !environmentIds.has(id))
                  .map((candidate) => (
                    <Ariakit.MenuItem
                      key={candidate.id}
                      hideOnClick={false}
                      className={menuItemClasses(machineId === candidate.id)}
                      onClick={() => setMachineId(candidate.id)}
                    >
                      <Monitor
                        className="text-text-secondary mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="text-text-primary min-w-0 flex-1 truncate text-left text-sm">
                        {candidate.name ?? candidate.id}
                      </span>
                    </Ariakit.MenuItem>
                  ))}
                {machine != null &&
                  (machineReady ? (
                    <EnvironmentWorkspaces
                      environment={machine}
                      workspaces={machineStatus?.workspaces ?? []}
                      emptyLabel={localize('com_ui_code_workspace_unavailable')}
                      hideOnClick={true}
                      isSelected={() => false}
                      onSelect={selectWorkspace}
                    />
                  ) : (
                    <Ariakit.MenuItem
                      hideOnClick={false}
                      className={menuItemClasses()}
                      disabled={machineQuery?.isLoading}
                      aria-busy={machineQuery?.isLoading}
                      onClick={() => void machineQuery?.refetch()}
                    >
                      <RefreshCw
                        className="text-text-secondary mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span role="status" className="text-text-secondary text-sm">
                        {localize(
                          machineQuery?.isLoading
                            ? 'com_ui_code_workspace_loading'
                            : 'com_ui_code_workspace_unavailable',
                        )}
                      </span>
                    </Ariakit.MenuItem>
                  ))}
              </>
            )}
          </>
        )}
        <Ariakit.MenuSeparator className="border-border-light my-1 h-0 w-full border-t" />
        <Ariakit.MenuItem
          disabled={buttonDisabled || isRefreshing}
          hideOnClick={false}
          onClick={() => void refresh()}
          aria-busy={isRefreshing}
          className={cn(
            menuItemClasses(),
            'items-center aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
          )}
        >
          <RefreshCw className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
          <span className="text-text-primary text-sm font-medium">
            {localize('com_ui_refresh')}
          </span>
        </Ariakit.MenuItem>
      </Ariakit.Menu>
      {workspace.environments.length > 1 && (
        <WorkspaceRequirements
          id={`${requirementsId}-checkouts`}
          requirements={checkoutSummaries}
        />
      )}
    </Ariakit.MenuProvider>
  );
}
