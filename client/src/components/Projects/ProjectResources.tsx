import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { v4 } from 'uuid';
import * as Ariakit from '@ariakit/react';
import {
  ChevronDown,
  FilePlus2,
  Files,
  Info,
  Link2,
  Loader2,
  Paperclip,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  Alert,
  Button,
  DropdownPopup,
  EmptyState,
  FileUpload,
  OGDialog,
  Spinner,
  TooltipAnchor,
  useToastContext,
} from '@librechat/client';
import {
  defaultAgentCapabilities,
  EToolResources,
  FileContext,
  MAX_CHAT_PROJECT_FILES,
  PermissionTypes,
  Permissions,
} from 'librechat-data-provider';
import type { TChatProjectFile, TError, TFile, TFileUpload } from 'librechat-data-provider';
import type { FileView } from '~/components/Chat/Input/Composer/Files';
import {
  useAddProjectFileMutation,
  useGetStartupConfig,
  useProjectAvailableFilesInfiniteQuery,
  useProjectFilesQuery,
  useRemoveProjectFileMutation,
  useUploadFileMutation,
} from '~/data-provider';
import { useAgentCapabilities, useGetAgentsConfig, useHasAccess, useLocalize } from '~/hooks';
import FileGrid, { FILE_VIEWS } from '~/components/Chat/Input/Composer/Files';
import { CatalogContent } from '~/components/Chat/Input/Composer/Catalog';
import { NotificationSeverity, type LocalizeFunction } from '~/common';
type ProjectResourcesProps = {
  project: { _id: string; fileCount?: number };
};

type UploadState = {
  id: string;
  filename: string;
  file: File;
  fileId?: string;
  errorMessage?: string;
  status: 'processing' | 'failed';
};

const getUploadErrorMessage = (error: unknown, localize: LocalizeFunction): string => {
  const uploadError = error as TError | undefined;
  if (uploadError?.code === 'ERR_CANCELED') {
    return localize('com_error_files_upload_canceled');
  }
  const responseData = uploadError?.response?.data;
  if (typeof responseData?.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }
  return localize('com_error_files_upload');
};

/** Attaching answers 409 only when the project is full; every other failure reads the same. */
const getAssociationErrorMessage = (
  error: unknown,
  localize: LocalizeFunction,
  fileLimit: number,
): string =>
  (error as TError | undefined)?.response?.status === 409
    ? localize('com_ui_project_file_limit', { count: fileLimit })
    : localize('com_ui_project_file_attach_error');
function statusLabel(localize: LocalizeFunction, availability: TChatProjectFile['availability']) {
  return availability === 'ready'
    ? localize('com_ui_project_file_ready')
    : localize('com_ui_project_file_unavailable');
}

const isEligibleFile = (file: TFile) =>
  file.embedded === true &&
  file.context === FileContext.message_attachment &&
  (!file.expiredAt || new Date(file.expiredAt).getTime() > Date.now());
export default function ProjectResources({ project }: ProjectResourcesProps) {
  const localize = useLocalize();
  const { agentsConfig } = useGetAgentsConfig();
  const { fileSearchEnabled } = useAgentCapabilities(
    agentsConfig?.capabilities ?? defaultAgentCapabilities,
  );
  const { data: startupConfig } = useGetStartupConfig();
  const projectFileLimit = startupConfig?.projects?.maxFiles ?? MAX_CHAT_PROJECT_FILES;
  const canUseFileSearch = useHasAccess({
    permissionType: PermissionTypes.FILE_SEARCH,
    permission: Permissions.USE,
  });
  const canUploadFromDevice = fileSearchEnabled && canUseFileSearch;
  const { showToast } = useToastContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerMenuRef = useRef<HTMLButtonElement>(null);
  const fileMenuId = useId();
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const deferredPickerSearch = useDeferredValue(pickerSearch);
  const [pickerView, setPickerView] = useState<FileView>('all');
  const fileViewOptions = useMemo(
    () => FILE_VIEWS.map((option) => ({ value: option.value, label: localize(option.labelKey) })),
    [localize],
  );
  const [uploading, setUploading] = useState<UploadState[]>([]);
  const pendingUploadIdsRef = useRef(new Set<string>());
  const optimisticAttachedIdsRef = useRef(new Set<string>());
  const [optimisticAttachedIds, setOptimisticAttachedIds] = useState<string[]>([]);
  const { data: projectFiles, isLoading, isError, refetch } = useProjectFilesQuery(project._id);
  const listedCount = projectFiles?.length;
  const [tracked, setTracked] = useState({ projectId: project._id, count: listedCount });
  const [announcement, setAnnouncement] = useState('');
  if (tracked.projectId !== project._id || tracked.count !== listedCount) {
    const isSameProject = tracked.projectId === project._id;
    const previous = tracked.count;
    setTracked({ projectId: project._id, count: listedCount });
    if (!isSameProject || previous == null || listedCount == null) {
      setAnnouncement('');
    } else {
      setAnnouncement(
        localize(
          listedCount > previous ? 'com_ui_project_file_added' : 'com_ui_project_file_removed',
        ),
      );
    }
  }
  const availableFilesQuery = useProjectAvailableFilesInfiniteQuery(
    project._id,
    { search: deferredPickerSearch || undefined, limit: 20 },
    { enabled: isPickerOpen },
  );
  const {
    data: availableFilesData,
    isLoading: isFilesLoading,
    isFetchingNextPage,
    isError: isFilesError,
    hasNextPage,
    fetchNextPage,
    refetch: refetchFiles,
  } = availableFilesQuery;
  /** The project and search whose last error came from loading a further page, so Retry
   *  fetches that page again rather than refetching what is already listed. It lapses
   *  once the query recovers, and never carries over to another project or search. */
  const pageQueryKey = `${project._id}\u0000${deferredPickerSearch}`;
  const [failedPageKey, setFailedPageKey] = useState<string | null>(null);
  if (failedPageKey != null && !isFilesError) {
    setFailedPageKey(null);
  }
  const nextPageFailed = failedPageKey === pageQueryKey;
  /** The query a settling page request is checked against, so a request started for an
   *  earlier project or search never rewrites the current query's marker. */
  const activePageQueryKeyRef = useRef(pageQueryKey);
  useEffect(() => {
    activePageQueryKeyRef.current = pageQueryKey;
  }, [pageQueryKey]);
  const loadNextPage = () => {
    const requestKey = pageQueryKey;
    void fetchNextPage().then((result) => {
      if (requestKey === activePageQueryKeyRef.current) {
        setFailedPageKey(result.isError ? requestKey : null);
      }
    });
  };
  const uploadFile = useUploadFileMutation();
  const addFile = useAddProjectFileMutation();
  const removeFile = useRemoveProjectFileMutation();
  const attachedIds = useMemo(
    () => new Set((projectFiles ?? []).map((file) => file.file_id)),
    [projectFiles],
  );
  const availableFiles = useMemo(
    () => availableFilesData?.pages.flatMap((page) => page.files) ?? [],
    [availableFilesData?.pages],
  );
  const fileCount = projectFiles?.length ?? project.fileCount ?? 0;
  const getEffectiveFileCount = () => {
    let count = fileCount + pendingUploadIdsRef.current.size;
    for (const fileId of optimisticAttachedIdsRef.current) {
      if (!attachedIds.has(fileId)) {
        count++;
      }
    }
    return count;
  };
  const hasFileCapacity = getEffectiveFileCount() < projectFileLimit;

  useEffect(() => {
    const remaining = optimisticAttachedIds.filter((fileId) => !attachedIds.has(fileId));
    if (remaining.length !== optimisticAttachedIds.length) {
      const remainingSet = new Set(remaining);
      optimisticAttachedIdsRef.current = remainingSet;
      setOptimisticAttachedIds(remaining);
    }
  }, [attachedIds, optimisticAttachedIds]);

  useEffect(() => {
    if (
      isPickerOpen &&
      !isFilesLoading &&
      !isFilesError &&
      availableFiles.length === 0 &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      void fetchNextPage();
    }
  }, [
    availableFiles.length,
    fetchNextPage,
    hasNextPage,
    isFilesError,
    isFilesLoading,
    isFetchingNextPage,
    isPickerOpen,
  ]);
  useEffect(() => {
    setPickerSearch('');
    setPickerView('all');
  }, [project._id]);

  const addExistingFile = async (fileId: string) => {
    try {
      await addFile.mutateAsync({ projectId: project._id, file_id: fileId });
      setIsPickerOpen(false);
      setIsFileMenuOpen(false);
    } catch (error: unknown) {
      showToast({
        message: getAssociationErrorMessage(error, localize, projectFileLimit),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    }
  };

  const runUpload = async (item: UploadState) => {
    let uploaded = false;
    try {
      let fileId = item.fileId;
      if (!fileId) {
        const formData = new FormData();
        formData.append('file', item.file);
        formData.append('file_id', item.id);
        formData.append('endpoint', 'agents');
        formData.append('message_file', 'true');
        formData.append('tool_resource', EToolResources.file_search);
        const uploaded = (await uploadFile.mutateAsync(formData)) as TFileUpload;
        if (!uploaded.file_id || !isEligibleFile(uploaded)) {
          throw new Error('Uploaded file is not eligible for project search');
        }
        fileId = uploaded.file_id;
        setUploading((current) =>
          current.map((candidate) =>
            candidate.id === item.id ? { ...candidate, fileId } : candidate,
          ),
        );
      }
      uploaded = true;
      await addFile.mutateAsync({ projectId: project._id, file_id: fileId });
      pendingUploadIdsRef.current.delete(item.id);
      optimisticAttachedIdsRef.current.add(fileId);
      setOptimisticAttachedIds(Array.from(optimisticAttachedIdsRef.current));
      setUploading((current) => current.filter((candidate) => candidate.id !== item.id));
    } catch (error: unknown) {
      pendingUploadIdsRef.current.delete(item.id);
      const errorMessage = uploaded
        ? getAssociationErrorMessage(error, localize, projectFileLimit)
        : getUploadErrorMessage(error, localize);
      setUploading((current) =>
        current.map((candidate) =>
          candidate.id === item.id ? { ...candidate, errorMessage, status: 'failed' } : candidate,
        ),
      );
    }
  };

  const processUploads = async (items: UploadState[]) => {
    for (const item of items) {
      await runUpload(item);
    }
  };

  const handleUploadChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!selected.length || !canUploadFromDevice) {
      return;
    }
    const availableCapacity = Math.max(0, projectFileLimit - getEffectiveFileCount());
    const accepted = selected.slice(0, availableCapacity).map((file) => ({
      id: v4(),
      filename: file.name,
      file,
      status: 'processing' as const,
    }));
    accepted.forEach((item) => pendingUploadIdsRef.current.add(item.id));
    if (accepted.length) {
      setUploading((current) => [...current, ...accepted]);
      void processUploads(accepted);
    }
    if (selected.length > accepted.length) {
      showToast({
        message: localize('com_ui_project_file_excess', {
          count: selected.length - accepted.length,
        }),
        severity: NotificationSeverity.WARNING,
        showIcon: true,
      });
    }
  };

  const remove = async (fileId: string) => {
    try {
      await removeFile.mutateAsync({ projectId: project._id, file_id: fileId });
    } catch {
      showToast({
        message: localize('com_ui_project_file_remove_error'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    }
  };

  const retryUpload = (item: UploadState) => {
    if (pendingUploadIdsRef.current.has(item.id) || (!item.fileId && !canUploadFromDevice)) {
      return;
    }
    if (getEffectiveFileCount() >= projectFileLimit) {
      showToast({
        message: localize('com_ui_project_file_excess', { count: 1 }),
        severity: NotificationSeverity.WARNING,
        showIcon: true,
      });
      return;
    }
    pendingUploadIdsRef.current.add(item.id);
    setUploading((current) =>
      current.map((candidate) =>
        candidate.id === item.id
          ? { ...candidate, errorMessage: undefined, status: 'processing' }
          : candidate,
      ),
    );
    void runUpload({ ...item, errorMessage: undefined, status: 'processing' });
  };

  const dismissUpload = (id: string) => {
    pendingUploadIdsRef.current.delete(id);
    setUploading((current) => current.filter((item) => item.id !== id));
  };

  return (
    <section
      className="border-border-light bg-surface-secondary flex h-full min-h-0 min-w-0 flex-col rounded-2xl border p-4 sm:p-5"
      aria-labelledby="project-resources-heading"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <h2 id="project-resources-heading" className="text-text-primary text-sm font-semibold">
            {localize('com_ui_project_files')}
          </h2>
          <TooltipAnchor
            description={`${localize('com_ui_project_files_help')} ${localize('com_ui_project_files_retrieval_only')}`}
            render={
              <Button
                type="button"
                variant="section-action"
                size="icon-xs"
                className="relative shrink-0 after:absolute after:-inset-1.5"
                aria-label={localize('com_ui_project_files_info')}
              >
                <Info className="size-3.5" aria-hidden="true" />
              </Button>
            }
          />
        </div>
        <FileUpload ref={inputRef} handleFileChange={handleUploadChange}>
          <DropdownPopup
            portal={true}
            focusLoop={true}
            unmountOnHide={true}
            menuId={fileMenuId}
            isOpen={isFileMenuOpen}
            setIsOpen={setIsFileMenuOpen}
            trigger={
              <Ariakit.MenuButton
                disabled={!hasFileCapacity || uploadFile.isLoading || addFile.isLoading}
                className="aria-expanded:bg-surface-hover"
                render={<Button type="button" variant="outline" size="sm" />}
              >
                <Plus className="size-4" aria-hidden="true" />
                {localize('com_ui_project_add_files')}
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </Ariakit.MenuButton>
            }
            items={[
              ...(canUploadFromDevice
                ? [
                    {
                      label: localize('com_ui_project_upload_file'),
                      icon: <Upload className="text-text-secondary size-4" aria-hidden="true" />,
                      onClick: () => inputRef.current?.click(),
                    },
                  ]
                : []),
              {
                label: localize('com_ui_project_choose_file'),
                icon: <Link2 className="text-text-secondary size-4" aria-hidden="true" />,
                onClick: () => setIsPickerOpen(true),
                hideOnClick: false,
                ref: pickerMenuRef,
                render: (props) => <button {...props} />,
              },
            ]}
          />
        </FileUpload>
      </div>

      {!hasFileCapacity && (
        <p className="text-text-secondary mb-3 text-xs" role="note">
          {localize('com_ui_project_file_limit', { count: projectFileLimit })}
        </p>
      )}
      {isError && (
        <Alert
          variant="error"
          icon={false}
          role="alert"
          className="flex items-center justify-between"
        >
          <span>{localize('com_ui_project_files_error')}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </Alert>
      )}
      {!isError && isLoading && (
        <div
          className="border-border-light bg-surface-secondary text-text-secondary flex min-h-16 items-center justify-center rounded-xl border"
          role="status"
        >
          <Spinner className="size-4" />
          <span className="sr-only">{localize('com_ui_loading')}</span>
        </div>
      )}
      {!isError && !isLoading && (
        <>
          <div className="sr-only" role="status" aria-live="polite">
            {announcement}
          </div>
          <div
            className="min-h-0 flex-1 space-y-2 overflow-y-auto"
            role="list"
            aria-label={localize('com_ui_project_files')}
          >
            {uploading.map((item) => (
              <div
                key={item.id}
                role="listitem"
                aria-describedby={item.errorMessage ? `${item.id}-error` : undefined}
                className="border-border-light bg-surface-secondary flex flex-wrap items-center gap-3 rounded-xl border px-3.5 py-3"
              >
                {item.status === 'processing' ? (
                  <Loader2
                    className="text-text-secondary size-4 shrink-0 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <FilePlus2 className="text-text-destructive size-4 shrink-0" aria-hidden="true" />
                )}
                <span className="text-text-primary min-w-0 flex-1 truncate text-sm">
                  {item.filename}
                </span>
                <span className="text-text-secondary text-xs">
                  {item.status === 'processing'
                    ? localize('com_ui_project_file_processing')
                    : localize('com_ui_project_file_failed')}
                </span>
                {item.errorMessage && (
                  <p
                    id={`${item.id}-error`}
                    role="alert"
                    className="text-text-destructive basis-full text-xs"
                  >
                    {item.errorMessage}
                  </p>
                )}
                {item.status === 'failed' && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!item.fileId && !canUploadFromDevice}
                      onClick={() => retryUpload(item)}
                    >
                      {localize('com_ui_retry')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label={localize('com_ui_project_dismiss_upload', {
                        name: item.filename,
                      })}
                      onClick={() => dismissUpload(item.id)}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </>
                )}
              </div>
            ))}
            {projectFiles?.map((file) => (
              <div
                key={file.file_id}
                role="listitem"
                className="border-border-light bg-surface-secondary flex items-center gap-3 rounded-xl border px-3.5 py-3"
              >
                <Paperclip className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
                <TooltipAnchor
                  description={file.filename ?? file.file_id}
                  render={
                    <span className="text-text-primary min-w-0 flex-1 truncate text-sm">
                      {file.filename ?? file.file_id}
                    </span>
                  }
                />
                <span
                  className={
                    file.availability === 'ready'
                      ? 'text-text-secondary text-xs'
                      : 'text-text-destructive text-xs'
                  }
                >
                  {statusLabel(localize, file.availability)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  aria-label={localize('com_ui_project_remove_file', {
                    name: file.filename ?? file.file_id,
                  })}
                  onClick={() => void remove(file.file_id)}
                  disabled={removeFile.isLoading}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
            {!uploading.length && !projectFiles?.length && (
              <EmptyState
                icon={Files}
                description={localize('com_ui_project_no_files')}
                className="h-full"
              />
            )}
          </div>
        </>
      )}

      <OGDialog
        open={isPickerOpen}
        onOpenChange={(open) => {
          setIsPickerOpen(open);
          if (!open) {
            setIsFileMenuOpen(false);
          }
        }}
        triggerRef={pickerMenuRef}
      >
        {isPickerOpen ? (
          <CatalogContent
            title={localize('com_ui_project_choose_file')}
            searchLabel={localize('com_ui_search_files')}
            search={pickerSearch}
            onSearchChange={setPickerSearch}
            filterLabel={localize('com_ui_composer_files_filter')}
            viewOptions={fileViewOptions}
            view={pickerView}
            onViewChange={(value) => setPickerView(value as FileView)}
          >
            <FileGrid
              query={deferredPickerSearch.trim().toLowerCase()}
              view={pickerView}
              onAttach={(file) => void addExistingFile(file.file_id)}
              source={{
                files: availableFiles,
                /* A further page can still hold a match for the current search or view. */
                isLoading: isFilesLoading || isFetchingNextPage,
                isError: isFilesError,
                refetch: () => void refetchFiles(),
              }}
              disabled={addFile.isLoading || !hasFileCapacity}
              emptyText={
                deferredPickerSearch || pickerView !== 'all'
                  ? localize('com_ui_no_search_results')
                  : localize('com_ui_project_no_eligible_files')
              }
            />
            {/* A later page that fails keeps the loaded cards; the grid only shows
                its own retry while nothing has loaded. */}
            {isFilesError && availableFiles.length > 0 && (
              <Alert
                variant="error"
                icon={false}
                role="alert"
                className="mt-3 flex items-center justify-between"
              >
                <span>{localize('com_ui_project_files_error')}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isFetchingNextPage}
                  onClick={() => (nextPageFailed ? loadNextPage() : void refetchFiles())}
                >
                  {localize('com_ui_retry')}
                </Button>
              </Alert>
            )}
            {!isFilesLoading && !isFilesError && hasNextPage && (
              <Button
                type="button"
                variant="outline"
                className="mt-3 w-full"
                onClick={loadNextPage}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? localize('com_ui_loading') : localize('com_ui_load_more')}
              </Button>
            )}
          </CatalogContent>
        ) : null}
      </OGDialog>
    </section>
  );
}
