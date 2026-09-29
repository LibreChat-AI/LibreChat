import { useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { Check, ChevronDown, Folder, FolderSync, FolderX, RefreshCw } from 'lucide-react';
import { TooltipAnchor, composerControlClasses, useToastContext } from '@librechat/client';
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
    'outline-none transition-colors duration-theme-fast',
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
  choices: Record<string, string>,
): string | undefined {
  const choice = choices[target.environment.id];
  if (choice != null && target.workspaces.some(({ id }) => id === choice)) return choice;
  return target.workspaces.length === 1 ? target.workspaces[0].id : undefined;
}

function EnvironmentWorkspaces({
  environment,
  workspaces,
  emptyLabel,
  hideOnClick,
  isSelected,
  onSelect,
}: {
  environment: CodeWorkspaceEnvironmentResult['environment'];
  workspaces: CodeWorkspaceEnvironmentResult['workspaces'];
  emptyLabel: string;
  hideOnClick: boolean;
  isSelected: (workspaceId: string) => boolean;
  onSelect: (selection: CodeWorkspaceSelection) => void;
}) {
  const localize = useLocalize();
  return (
    <div>
      <Ariakit.MenuHeading render={<div />} className={headingClasses}>
        {environment.name ?? environment.id}
      </Ariakit.MenuHeading>
      {workspaces.length === 0 && (
        <div className="px-2.5 py-2 text-sm text-text-secondary">{emptyLabel}</div>
      )}
      {workspaces.map((descriptor) => {
        const selected = isSelected(descriptor.id);
        return (
          <Ariakit.MenuItemRadio
            key={descriptor.id}
            name={`codeWorkspace:${environment.id}`}
            value={descriptor.id}
            checked={selected}
            hideOnClick={hideOnClick}
            onChange={() => onSelect({ environmentId: environment.id, workspaceId: descriptor.id })}
            className={menuItemClasses(selected)}
          >
            <Folder className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <div className="min-w-0 flex-1 text-left">
              <div className="truncate text-sm font-medium text-text-primary">
                {descriptor.name ?? descriptor.id}
              </div>
              {descriptor.name && (
                <p className="truncate text-xs text-text-secondary">{descriptor.id}</p>
              )}
              {descriptor.instructions !== undefined && (
                <p className="truncate text-xs text-text-secondary">
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
                <p className="truncate text-xs text-text-secondary">
                  {[descriptor.environment.repo, descriptor.environment.ref]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>
            {selected && (
              <Check className="mt-0.5 size-4 shrink-0 text-text-primary" aria-hidden="true" />
            )}
          </Ariakit.MenuItemRadio>
        );
      })}
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
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const menuStore = Ariakit.useMenuStore({ focusLoop: true, placement: 'top-start' });
  const isOpen = menuStore.useState('open');
  const moveMutation = useMoveConversationCodeEnvironmentMutation(setConversation);
  const reconcileMutation = useReconcileConversationCodeEnvironmentMutation(setConversation);
  const { refresh, isRefreshing } = useCodeWorkspaceRefresh();
  const [moveDraft, setMoveDraft] = useState<{
    conversationId: string;
    workspaces: Record<string, string>;
  } | null>(null);

  if (!workspace.visible) return null;

  if (workspace.recovery != null) {
    const { request, status } = workspace.recovery;
    const pending = status === 'pending';
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span role="status" className="text-xs text-text-secondary">
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
    workspace.rememberSelection(selection);
    setConversation((current) => {
      if (current == null) return current;
      const retained = (current.codeWorkspaces ?? workspace.selections ?? []).filter(
        ({ environmentId }) =>
          environmentIds.has(environmentId) && environmentId !== selection.environmentId,
      );
      return {
        ...current,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [...retained, selection].sort((a, b) =>
          a.environmentId.localeCompare(b.environmentId),
        ),
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
      return workspaceId == null ? [] : [{ environmentId: target.environment.id, workspaceId }];
    }) ?? [];
  /** A transition replaces the whole decision, so an empty target set is the detach and gets its
   *  own item: this one only confirms a decision that still names at least one workspace. */
  const proposed = transition == null ? [] : [...transition.retained, ...chosenTargets];
  const offersMove =
    transition != null && (transition.targets.length > 0 || transition.retained.length > 0);
  const moveReady =
    transition != null && chosenTargets.length === transition.targets.length && proposed.length > 0;
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
  const Icon =
    workspace.mode === 'without_attached' ||
    workspace.state === 'missing' ||
    workspace.state === 'unavailable'
      ? FolderX
      : Folder;

  if (workspace.locked && transition == null) {
    /** A sealed decision with no transition on offer only reports where this chat runs: without a
     *  workspace by its own recorded choice, or on a machine that needs attention. Whether that is
     *  worth showing at all is `visible`, above. */
    const recovery =
      workspace.mode === 'without_attached'
        ? localize('com_ui_code_workspace_without_attached_info')
        : localize('com_ui_code_workspace_locked_recovery');
    return (
      <TooltipAnchor
        description={recovery}
        render={
          <button
            type="button"
            data-testid="code-workspace-locked-status"
            disabled={disabled || isRefreshing}
            onClick={() => void refresh()}
            aria-label={`${label}. ${recovery}. ${localize('com_ui_retry')}`}
            aria-busy={isRefreshing}
            className={cn(composerControlClasses(), 'min-w-0 max-w-full px-2.5')}
          />
        }
      >
        <Icon className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span role="status" className="min-w-0 max-w-[16rem] truncate">
          {label}
        </span>
        <RefreshCw className="size-3 shrink-0 text-text-secondary" aria-hidden="true" />
      </TooltipAnchor>
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
      <TooltipAnchor
        description={transitionText?.info ?? localize('com_ui_code_workspace')}
        disabled={isOpen}
        render={
          <Ariakit.MenuButton
            disabled={buttonDisabled}
            data-testid={renamesForMove ? 'code-workspace-move' : 'code-workspace'}
            aria-label={
              transitionText == null
                ? `${localize('com_ui_code_workspace')}: ${label}`
                : `${buttonLabel}. ${transitionText.info}`
            }
            className={cn(
              composerControlClasses(),
              'min-w-0 max-w-full px-2.5 md:px-theme-normal',
              isOpen && 'bg-surface-hover',
              buttonDisabled && 'cursor-not-allowed opacity-50',
            )}
          />
        }
      >
        <ButtonIcon className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="min-w-0 max-w-[12rem] truncate">{buttonLabel}</span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-text-secondary transition-transform',
            isOpen && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </TooltipAnchor>
      <Ariakit.Menu
        portal={true}
        gutter={8}
        unmountOnHide={true}
        className={cn(
          'z-50 flex min-w-[280px] max-w-[min(360px,calc(100vw-2rem))] flex-col rounded-xl',
          'max-h-[var(--popover-available-height)] overflow-y-auto border border-border-light bg-presentation p-1.5 shadow-lg',
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
            <p className="px-2.5 pb-2 text-xs text-text-secondary">{transitionText.info}</p>
            {transition.targets.map((target) => (
              <EnvironmentWorkspaces
                key={target.environment.id}
                environment={target.environment}
                workspaces={target.workspaces}
                emptyLabel={localize('com_ui_code_workspace_unavailable')}
                hideOnClick={false}
                isSelected={(workspaceId) => chosenWorkspaceId(target, moveChoices) === workspaceId}
                onSelect={({ environmentId, workspaceId }) =>
                  setMoveDraft({
                    conversationId: transition.conversationId,
                    workspaces: { ...moveChoices, [environmentId]: workspaceId },
                  })
                }
              />
            ))}
            <Ariakit.MenuSeparator className="my-1 h-0 w-full border-t border-border-light" />
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
                <ConfirmIcon className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-text-primary">
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
                  className="mt-0.5 size-4 shrink-0 text-text-secondary"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-medium text-text-primary">
                    {localize('com_ui_code_workspace_detach')}
                  </div>
                  <p className="text-xs text-text-secondary">
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
                  className="mt-0.5 size-4 shrink-0 text-text-secondary"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-medium text-text-primary">
                    {localize('com_ui_code_workspace_without_attached')}
                  </div>
                  <p className="text-xs text-text-secondary">
                    {localize('com_ui_code_workspace_without_attached_info')}
                  </p>
                </div>
                {workspace.mode === 'without_attached' && (
                  <Check className="mt-0.5 size-4 shrink-0 text-text-primary" aria-hidden="true" />
                )}
              </Ariakit.MenuItemRadio>
            )}
            {workspace.environments.map(({ environment, state, workspaces, selected }) => (
              <EnvironmentWorkspaces
                key={environment.id}
                environment={environment}
                workspaces={workspaces}
                emptyLabel={localize(stateLabels[state] ?? 'com_ui_code_workspace_unavailable')}
                hideOnClick={true}
                isSelected={(workspaceId) =>
                  workspace.mode === 'attached' && workspaceId === selected?.workspaceId
                }
                onSelect={selectWorkspace}
              />
            ))}
          </>
        )}
        <Ariakit.MenuSeparator className="my-1 h-0 w-full border-t border-border-light" />
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
          <RefreshCw className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="text-sm font-medium text-text-primary">
            {localize('com_ui_refresh')}
          </span>
        </Ariakit.MenuItem>
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
}
