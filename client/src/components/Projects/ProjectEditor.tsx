import { useEffect, useRef } from 'react';
import { Folder } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Button, Input, Label, Spinner, Textarea, useToastContext } from '@librechat/client';
import {
  MAX_CHAT_PROJECT_DESCRIPTION_LENGTH,
  MAX_CHAT_PROJECT_NAME_LENGTH,
} from 'librechat-data-provider';
import type { KeyboardEvent, MutableRefObject, RefObject } from 'react';
import type { TChatProject } from 'librechat-data-provider';
import { useUpdateProjectMutation, useGetStartupConfig } from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export type ProjectEditorProps = {
  project: TChatProject;
  onDone: () => void;
  layout?: 'workspace' | 'dialog';
  inputRef?: RefObject<HTMLInputElement>;
  initialField?: 'name' | 'description';
  /** A host that outlives the editor, such as a dialog, passes its own mutation so the
   *  save settles (and reports) even if the editor unmounts first. */
  updateProject?: ReturnType<typeof useUpdateProjectMutation>;
};

type ProjectEditorForm = {
  name: string;
  description: string;
};

export default function ProjectEditor({
  project,
  onDone,
  layout = 'workspace',
  inputRef,
  initialField = 'name',
  updateProject: hostUpdateProject,
}: ProjectEditorProps) {
  const localize = useLocalize();
  const ownUpdateProject = useUpdateProjectMutation();
  const updateProject = hostUpdateProject ?? ownUpdateProject;
  const { data: startupConfig } = useGetStartupConfig();
  const descriptionLimit =
    startupConfig?.projects?.maxDescriptionLength ?? MAX_CHAT_PROJECT_DESCRIPTION_LENGTH;
  const { showToast } = useToastContext();
  const isSavingRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<ProjectEditorForm>({
    defaultValues: {
      name: project.name,
      description: project.description ?? '',
    },
  });
  const nameRegistration = register('name', {
    validate: (value) => value.trim().length > 0 || localize('com_ui_field_required'),
    maxLength: {
      value: MAX_CHAT_PROJECT_NAME_LENGTH,
      message: localize('com_ui_field_max_length', {
        field: localize('com_ui_project_name'),
        length: MAX_CHAT_PROJECT_NAME_LENGTH,
      }),
    },
  });
  const descriptionRegistration = register('description', {
    maxLength: {
      value: descriptionLimit,
      message: localize('com_ui_field_max_length', {
        field: localize('com_ui_description'),
        length: descriptionLimit,
      }),
    },
  });
  const isBusy = updateProject.isLoading;
  const isWorkspace = layout === 'workspace';
  const labelClassName = isWorkspace ? 'sr-only' : undefined;
  const buttonSize = isWorkspace ? 'sm' : 'default';
  const nameId = `project-editor-${project._id}-name`;
  const descriptionId = `project-editor-${project._id}-description`;
  const nameErrorId = `${nameId}-error`;
  const descriptionErrorId = `${descriptionId}-error`;

  useEffect(() => {
    const focusField = () => setFocus(initialField);
    /** Sidebar navigation can mount this form before the pane loses `inert`. */
    const inertAncestor = nameInputRef.current?.closest('[inert]');
    if (!inertAncestor) {
      focusField();
      return;
    }

    const observer = new MutationObserver(() => {
      if (nameInputRef.current?.closest('[inert]')) {
        return;
      }
      observer.disconnect();
      focusField();
    });
    observer.observe(inertAncestor, { attributes: true, attributeFilter: ['inert'] });
    return () => observer.disconnect();
  }, [initialField, setFocus]);

  const assignNameRef = (node: HTMLInputElement | null) => {
    nameRegistration.ref(node);
    nameInputRef.current = node;
    if (inputRef) {
      (inputRef as MutableRefObject<HTMLInputElement | null>).current = node;
    }
  };

  const onSubmit = ({ name, description }: ProjectEditorForm) => {
    if (isSavingRef.current || updateProject.isLoading) {
      return;
    }

    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    if (!trimmedName) {
      return;
    }

    const isUnchanged =
      trimmedName === project.name && trimmedDescription === (project.description ?? '').trim();
    if (isUnchanged) {
      onDone();
      return;
    }

    isSavingRef.current = true;
    updateProject.mutate(
      {
        projectId: project._id,
        name: trimmedName,
        description: trimmedDescription,
      },
      {
        onSuccess: () => {
          isSavingRef.current = false;
          onDone();
        },
        onError: () => {
          isSavingRef.current = false;
          showToast({
            message: localize('com_ui_project_rename_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          });
        },
      },
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!isSavingRef.current && !updateProject.isLoading) {
        onDone();
      }
    }
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      onKeyDown={handleKeyDown}
      aria-busy={isBusy}
      className={cn('flex w-full min-w-0 flex-col', isWorkspace ? 'gap-4' : 'gap-3')}
    >
      <div
        className={cn(
          'min-w-0',
          isWorkspace
            ? 'grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3'
            : 'flex flex-col gap-4',
        )}
      >
        {isWorkspace ? (
          <span
            className="bg-surface-secondary text-text-secondary flex size-12 shrink-0 items-center justify-center rounded-2xl"
            aria-hidden="true"
          >
            <Folder className="size-6" aria-hidden="true" />
          </span>
        ) : null}
        <div className={cn('w-full min-w-0', !isWorkspace && 'space-y-2')}>
          <Label htmlFor={nameId} className={labelClassName}>
            {localize('com_ui_project_name')}
          </Label>
          <Input
            {...nameRegistration}
            ref={assignNameRef}
            id={nameId}
            required
            readOnly={isBusy}
            maxLength={MAX_CHAT_PROJECT_NAME_LENGTH}
            aria-invalid={errors.name ? 'true' : 'false'}
            aria-describedby={errors.name ? nameErrorId : undefined}
            variant={isWorkspace ? 'title' : undefined}
            className="w-full max-w-full min-w-0 overflow-hidden wrap-anywhere"
          />
          {errors.name ? (
            <p id={nameErrorId} role="alert" className="text-text-destructive mt-1 text-xs">
              {errors.name.message}
            </p>
          ) : null}
        </div>
        <div className={cn('w-full min-w-0', isWorkspace ? 'col-span-2' : 'space-y-2')}>
          <Label htmlFor={descriptionId} className={labelClassName}>
            {localize('com_ui_description')}{' '}
            <span className={cn(!isWorkspace && 'text-text-secondary font-normal')}>
              {localize('com_ui_optional')}
            </span>
          </Label>
          <Textarea
            {...descriptionRegistration}
            id={descriptionId}
            rows={3}
            readOnly={isBusy}
            maxLength={descriptionLimit}
            aria-invalid={errors.description ? 'true' : 'false'}
            aria-describedby={errors.description ? descriptionErrorId : undefined}
            variant="transparent"
            className={cn(
              'w-full max-w-full min-w-0 resize-none overflow-y-auto wrap-anywhere',
              isWorkspace ? 'h-24 max-h-32' : 'h-24 max-h-40',
            )}
          />
          {errors.description ? (
            <p id={descriptionErrorId} role="alert" className="text-text-destructive mt-1 text-xs">
              {errors.description.message}
            </p>
          ) : null}
        </div>
      </div>
      <div className={cn('flex min-w-0 justify-end', isWorkspace ? 'gap-2' : 'gap-4 pt-2')}>
        <Button
          type="button"
          variant="outline"
          size={buttonSize}
          onClick={onDone}
          disabled={isBusy}
        >
          {localize('com_ui_cancel')}
        </Button>
        <Button
          type="submit"
          variant="submit"
          size={buttonSize}
          disabled={isBusy}
          aria-label={localize('com_ui_save')}
        >
          {isBusy ? <Spinner className="size-4" /> : localize('com_ui_save')}
        </Button>
      </div>
    </form>
  );
}
