import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import debounce from 'lodash/debounce';
import { useRecoilValue } from 'recoil';
import { useParams } from 'react-router-dom';
import { Menu, Rocket, X } from 'lucide-react';
import { useForm, FormProvider } from 'react-hook-form';
import { Button, Skeleton, useToastContext } from '@librechat/client';
import {
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
} from 'librechat-data-provider';
import type { TCreatePrompt, TPrompt, TPromptGroup } from 'librechat-data-provider';
import {
  useGetPrompts,
  useGetPromptGroup,
  useAddPromptToGroup,
  useUpdatePromptGroup,
  useMakePromptProduction,
} from '~/data-provider';
import { useResourcePermissions, useHasAccess, useLocalize, useFocusTrap } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import CategorySelector from '../fields/CategorySelector';
import PromptVariables from '../display/PromptVariables';
import PromptVersions from '../display/PromptVersions';
import { usePromptGroupsContext } from '~/Providers';
import PromptDetails from '../display/PromptDetails';
import DeletePrompt from '../dialogs/DeletePrompt';
import NoPromptGroup from '../lists/NoPromptGroup';
import PromptEditor from '../editor/PromptEditor';
import SkeletonForm from '../utils/SkeletonForm';
import SharePrompt from '../dialogs/SharePrompt';
import Description from '../fields/Description';
import PromptName from '../fields/PromptName';
import { cn, findPromptGroup } from '~/utils';
import { PromptsEditorMode } from '~/common';
import Command from '../fields/Command';
import store from '~/store';

interface VersionsPanelProps {
  group: TPromptGroup;
  prompts: TPrompt[];
  selectedPrompt: TPrompt | undefined;
  selectionIndex: number;
  isLoadingPrompts: boolean;
  canEdit: boolean;
  setSelectionIndex: React.Dispatch<React.SetStateAction<number>>;
}

const VersionsPanel = React.memo(
  ({
    group,
    prompts,
    selectedPrompt,
    isLoadingPrompts,
    canEdit,
    selectionIndex,
    setSelectionIndex,
  }: VersionsPanelProps) => {
    const localize = useLocalize();
    const makeProductionMutation = useMakePromptProduction();

    const groupId = group?._id || '';
    const isLoadingGroup = !group;
    const isProductionVersion = selectedPrompt?._id === group?.productionId;

    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        {canEdit && (
          <div className="shrink-0 px-4 py-2">
            <Button
              variant="submit"
              size="sm"
              aria-label={localize('com_ui_make_production')}
              className={cn(
                'w-full gap-1.5 transition-all duration-200',
                isProductionVersion &&
                  'border-status-success-border bg-status-success-subtle text-status-success hover:bg-status-success-subtle border',
              )}
              onClick={() => {
                if (!selectedPrompt) {
                  return;
                }
                const { _id: promptVersionId = '', prompt } = selectedPrompt;
                makeProductionMutation.mutate({
                  id: promptVersionId,
                  groupId,
                  productionPrompt: { prompt },
                });
              }}
              disabled={
                isLoadingGroup ||
                !selectedPrompt ||
                isProductionVersion ||
                makeProductionMutation.isLoading ||
                !canEdit
              }
            >
              <Rocket className="size-4" aria-hidden="true" />
              <span className="text-sm font-medium">
                {isProductionVersion ? localize('com_ui_production') : localize('com_ui_deploy')}
              </span>
            </Button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {isLoadingPrompts &&
            Array.from({ length: 6 }).map((_, index: number) => (
              <div key={index} className="my-2">
                <Skeleton className="h-[4.5rem] w-full" />
              </div>
            ))}
          {!isLoadingPrompts && prompts.length > 0 && (
            <>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-text-secondary text-sm font-medium">
                  {localize('com_ui_versions')}
                </h2>
                <span className="bg-surface-tertiary text-text-secondary flex size-5 items-center justify-center rounded-full text-xs font-medium">
                  {prompts.length}
                </span>
              </div>
              <PromptVersions
                group={group}
                prompts={prompts}
                selectionIndex={selectionIndex}
                setSelectionIndex={setSelectionIndex}
              />
            </>
          )}
        </div>
      </div>
    );
  },
);

VersionsPanel.displayName = 'VersionsPanel';

interface HeaderActionsProps {
  group: TPromptGroup;
  canEdit: boolean;
  canDelete: boolean;
  selectedPromptId?: string;
  onCategoryChange?: (value: string) => void;
}

const HeaderActions = React.memo(
  ({ group, canEdit, canDelete, selectedPromptId, onCategoryChange }: HeaderActionsProps) => {
    const hasShareAccess = useHasAccess({
      permissionType: PermissionTypes.PROMPTS,
      permission: Permissions.SHARE,
    });

    const groupId = group?._id || '';
    const groupCategory = group?.category || '';
    const isLoadingGroup = !group;

    return (
      <div className="flex items-center gap-2">
        <CategorySelector
          className="h-10"
          currentCategory={groupCategory}
          onValueChange={canEdit ? onCategoryChange : undefined}
        />
        {hasShareAccess && <SharePrompt group={group} disabled={isLoadingGroup} />}
        {canDelete && (
          <DeletePrompt
            promptId={selectedPromptId}
            groupId={groupId}
            promptName={group?.name || ''}
            disabled={isLoadingGroup}
          />
        )}
      </div>
    );
  },
);

HeaderActions.displayName = 'HeaderActions';

const PromptForm = ({ promptId: promptIdProp }: { promptId?: string }) => {
  const params = useParams();
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { hasAccess, groupsQuery } = usePromptGroupsContext() ?? {};
  const alwaysMakeProd = useRecoilValue(store.alwaysMakeProd);
  const promptId = promptIdProp || params.promptId || '';

  const editorMode = useRecoilValue(store.promptsEditorMode);
  const isSmallScreen = useDrawerViewport();
  const [selectionIndex, setSelectionIndex] = useState<number>(0);

  const prevIsEditingRef = useRef(false);
  const sidePanelRef = useRef<HTMLDivElement>(null);
  const sidePanelTriggerRef = useRef<HTMLButtonElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [showSidePanel, setShowSidePanel] = useState(false);

  // Reset selection when navigating to a different prompt group
  useEffect(() => {
    setSelectionIndex(0);
    setIsEditing(false);
  }, [promptId]);

  const { data: group, isLoading: isLoadingGroup } = useGetPromptGroup(promptId, {
    enabled: hasAccess && !!promptId,
  });
  const { data: prompts = [], isLoading: isLoadingPrompts } = useGetPrompts(
    { groupId: promptId },
    { enabled: hasAccess && !!promptId },
  );

  const { hasPermission, isLoading: permissionsLoading } = useResourcePermissions(
    ResourceType.PROMPTGROUP,
    group?._id || '',
  );

  const canEdit = hasPermission(PermissionBits.EDIT);
  const canDelete = hasPermission(PermissionBits.DELETE);
  const canView = hasPermission(PermissionBits.VIEW);

  const methods = useForm({
    defaultValues: {
      prompt: '',
      promptName: group ? group.name : '',
      category: group ? group.category : '',
    },
  });
  const { handleSubmit, setValue, reset, watch } = methods;
  const promptText = watch('prompt');

  const selectedPrompt = useMemo(
    () => (prompts.length > 0 ? prompts[selectionIndex] : undefined),
    [prompts, selectionIndex],
  );

  const selectedPromptId = useMemo(() => selectedPrompt?._id, [selectedPrompt?._id]);

  const updateGroupMutation = useUpdatePromptGroup({
    onError: () => {
      showToast({
        status: 'error',
        message: localize('com_ui_prompt_update_error'),
      });
    },
  });

  const makeProductionMutation = useMakePromptProduction();
  const addPromptToGroupMutation = useAddPromptToGroup({
    onMutate: (variables) => {
      reset(
        {
          prompt: variables.prompt.prompt,
          category: group?.category || '',
        },
        { keepDirtyValues: true },
      );
    },
    onSuccess(data) {
      if (alwaysMakeProd && data.prompt._id != null && data.prompt._id && data.prompt.groupId) {
        makeProductionMutation.mutate({
          id: data.prompt._id,
          groupId: data.prompt.groupId,
          productionPrompt: { prompt: data.prompt.prompt },
        });
      }

      reset({
        prompt: data.prompt.prompt,
        promptName: group?.name || '',
        category: group?.category || '',
      });
    },
  });

  const onSave = useCallback(
    (value: string) => {
      if (!canEdit) {
        return;
      }
      if (!value) {
        // TODO: show toast, cannot be empty.
        return;
      }
      if (!selectedPrompt) {
        return;
      }

      const groupId = selectedPrompt.groupId || group?._id;
      if (!groupId) {
        return;
      }

      const tempPrompt: TCreatePrompt = {
        prompt: {
          type: selectedPrompt.type ?? 'text',
          groupId: groupId,
          prompt: value,
        },
      };

      if (value === selectedPrompt.prompt) {
        return;
      }

      // We're adding to an existing group, so use the addPromptToGroup mutation
      addPromptToGroupMutation.mutate({ ...tempPrompt, groupId });
    },
    [selectedPrompt, group, addPromptToGroupMutation, canEdit],
  );

  const handleLoadingComplete = useCallback(() => {
    if (isLoadingGroup || isLoadingPrompts) {
      return;
    }
    setInitialLoad(false);
  }, [isLoadingGroup, isLoadingPrompts]);

  const selectedPromptRef = useRef(selectedPrompt);
  useEffect(() => {
    selectedPromptRef.current = selectedPrompt;
  }, [selectedPrompt]);

  useEffect(() => {
    if (prevIsEditingRef.current && !isEditing && canEdit && selectedPromptRef.current) {
      handleSubmit((data) => onSave(data.prompt))();
    }
    prevIsEditingRef.current = isEditing;
  }, [isEditing, onSave, handleSubmit, canEdit]);

  useEffect(() => {
    handleLoadingComplete();
  }, [promptId, editorMode, group?.productionId, prompts, handleLoadingComplete]);

  useEffect(() => {
    setValue('prompt', selectedPrompt ? selectedPrompt.prompt : '', { shouldDirty: false });
    setValue('category', group ? group.category : '', { shouldDirty: false });
  }, [selectedPrompt, group, setValue]);

  useEffect(() => {
    const handleResize = () => {
      if (window.matchMedia('(min-width: 1022px)').matches) {
        setShowSidePanel(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleSidePanelEscape = useCallback(() => {
    setShowSidePanel(false);
    sidePanelTriggerRef.current?.focus();
  }, []);

  useFocusTrap(sidePanelRef, showSidePanel, handleSidePanelEscape);

  const debouncedUpdateOneliner = useMemo(
    () =>
      debounce(
        (
          groupId: string,
          oneliner: string,
          mutate: (vars: { id: string; payload: { oneliner: string } }) => void,
        ) => {
          mutate({ id: groupId, payload: { oneliner } });
        },
        950,
      ),
    [],
  );

  const debouncedUpdateCommand = useMemo(
    () =>
      debounce(
        (
          groupId: string,
          command: string,
          mutate: (vars: { id: string; payload: { command: string } }) => void,
        ) => {
          mutate({ id: groupId, payload: { command } });
        },
        950,
      ),
    [],
  );

  useEffect(() => {
    return () => {
      debouncedUpdateOneliner.cancel();
      debouncedUpdateCommand.cancel();
    };
  }, [debouncedUpdateOneliner, debouncedUpdateCommand]);

  const handleUpdateOneliner = useCallback(
    (oneliner: string) => {
      if (!group || !group._id) {
        return;
      }
      debouncedUpdateOneliner(group._id, oneliner, updateGroupMutation.mutate);
    },
    [group, updateGroupMutation.mutate, debouncedUpdateOneliner],
  );

  const handleUpdateCommand = useCallback(
    (command: string) => {
      if (!group || !group._id) {
        return;
      }
      debouncedUpdateCommand(group._id, command, updateGroupMutation.mutate);
    },
    [group, updateGroupMutation.mutate, debouncedUpdateCommand],
  );

  const handleCategoryChange = useCallback(
    (value: string) => {
      if (!group?._id) {
        return;
      }
      updateGroupMutation.mutate({
        id: group._id,
        payload: { name: group.name, category: value },
      });
    },
    [group?._id, group?.name, updateGroupMutation],
  );

  if (initialLoad) {
    return <SkeletonForm />;
  }

  // Show read-only view if user doesn't have edit permission
  if (!canEdit && !permissionsLoading && groupsQuery?.data) {
    const fetchedPrompt = findPromptGroup(groupsQuery?.data, (group) => group._id === promptId);
    if (!fetchedPrompt && !canView) {
      return <NoPromptGroup />;
    }

    if (fetchedPrompt || group) {
      return (
        <div className="flex h-full w-full flex-col">
          {isSmallScreen && (
            <div className="flex shrink-0 items-center px-4 pt-3">
              <OpenSidebar />
            </div>
          )}
          <PromptDetails group={fetchedPrompt || group} showActions={false} />
        </div>
      );
    }
  }

  if (!group || group._id == null) {
    return null;
  }

  const groupName = group.name;

  return (
    <FormProvider {...methods}>
      <form className="flex w-full" onSubmit={handleSubmit((data) => onSave(data.prompt))}>
        <h1 className="sr-only">{localize('com_ui_edit_prompt_page')}</h1>
        <div className="relative w-full overflow-hidden">
          <div
            className="h-full w-full"
            style={{
              transform: showSidePanel ? 'translateX(max(-85vw, -380px))' : 'translateX(0)',
              transition: 'transform 300ms cubic-bezier(0.2, 0, 0, 1)',
            }}
          >
            <div className="flex h-full">
              <div className="flex-1 overflow-hidden px-4">
                {/* Mobile Actions Row */}
                {!isLoadingGroup && group && isSmallScreen && (
                  <div className="mt-2 mb-3 flex items-center justify-between gap-2">
                    <OpenSidebar />
                    <HeaderActions
                      group={group}
                      canEdit={canEdit}
                      canDelete={canDelete}
                      selectedPromptId={selectedPromptId}
                      onCategoryChange={handleCategoryChange}
                    />
                  </div>
                )}
                {/* Header: Title + Actions */}
                <div className="mt-2 mb-3 flex items-center justify-between gap-2">
                  {isLoadingGroup ? (
                    <Skeleton className="h-9 w-48" />
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <PromptName
                          name={groupName}
                          isLoading={updateGroupMutation.isLoading}
                          isError={updateGroupMutation.isError}
                          onSave={(value) => {
                            if (!canEdit || !group._id) {
                              return;
                            }
                            updateGroupMutation.mutate({
                              id: group._id,
                              payload: { name: value },
                            });
                          }}
                        />
                        {editorMode === PromptsEditorMode.ADVANCED && (
                          <Button
                            ref={sidePanelTriggerRef}
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0 lg:hidden"
                            onClick={() => setShowSidePanel(true)}
                            aria-label={localize('com_ui_versions')}
                          >
                            <Menu className="size-4 sm:mr-1.5" aria-hidden="true" />
                            <span className="hidden sm:inline">{localize('com_ui_versions')}</span>
                          </Button>
                        )}
                      </div>
                      {!isSmallScreen && (
                        <div className="shrink-0">
                          <HeaderActions
                            group={group}
                            canEdit={canEdit}
                            canDelete={canDelete}
                            selectedPromptId={selectedPromptId}
                            onCategoryChange={handleCategoryChange}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Main Editor Content */}
                {isLoadingPrompts ? (
                  <Skeleton className="h-96" aria-live="polite" />
                ) : (
                  <div className="mb-2 flex h-full flex-col gap-3">
                    <PromptEditor
                      name="prompt"
                      isEditing={isEditing}
                      setIsEditing={(value) => canEdit && setIsEditing(value)}
                    />
                    <PromptVariables promptText={promptText} inset />
                    <Description
                      initialValue={group.oneliner ?? ''}
                      onValueChange={canEdit ? handleUpdateOneliner : undefined}
                      disabled={!canEdit}
                    />
                    <Command
                      initialValue={group.command ?? ''}
                      onValueChange={canEdit ? handleUpdateCommand : undefined}
                      disabled={!canEdit}
                    />
                  </div>
                )}
              </div>

              {/* Versions Sidebar - Advanced Mode Only */}
              {editorMode === PromptsEditorMode.ADVANCED && (
                <div className="border-border-medium hidden w-72 shrink-0 border-l lg:block xl:w-80">
                  <VersionsPanel
                    group={group}
                    prompts={prompts}
                    selectionIndex={selectionIndex}
                    selectedPrompt={selectedPrompt}
                    isLoadingPrompts={isLoadingPrompts}
                    canEdit={canEdit}
                    setSelectionIndex={setSelectionIndex}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Mobile Overlay */}
          <div
            aria-hidden={!showSidePanel}
            className={cn(
              'bg-scrim fixed inset-0 z-[100] lg:hidden',
              showSidePanel ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
            )}
            style={{ transition: 'opacity 300ms cubic-bezier(0.2, 0, 0, 1)' }}
          >
            <button
              type="button"
              className="h-full w-full cursor-default"
              onClick={() => setShowSidePanel(false)}
              aria-label={localize('com_ui_close_menu')}
              tabIndex={showSidePanel ? 0 : -1}
            />
          </div>

          {/* Mobile Versions Panel */}
          <div
            ref={sidePanelRef}
            className={cn(
              'border-border-medium bg-surface-primary-alt fixed top-0 right-0 z-[110] flex h-full flex-col border-l shadow-xl lg:hidden',
              showSidePanel ? 'translate-x-0' : 'translate-x-full',
            )}
            style={{
              width: 'min(85vw, 380px)',
              transition: 'transform 300ms cubic-bezier(0.2, 0, 0, 1)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label={localize('com_ui_versions')}
            inert={!showSidePanel ? '' : undefined}
          >
            <div className="flex items-center justify-between px-4 py-2">
              <h2 className="text-text-primary text-sm font-semibold">
                {localize('com_ui_versions')}
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setShowSidePanel(false)}
                aria-label={localize('com_ui_close')}
                className="size-8"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <VersionsPanel
              group={group}
              prompts={prompts}
              selectionIndex={selectionIndex}
              selectedPrompt={selectedPrompt}
              isLoadingPrompts={isLoadingPrompts}
              canEdit={canEdit}
              setSelectionIndex={setSelectionIndex}
            />
          </div>
        </div>
      </form>
    </FormProvider>
  );
};

export default PromptForm;
