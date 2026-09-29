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
  layout?: 'workspace' | 'card';
  inputRef?: RefObject<HTMLInputElement>;
  initialField?: 'name' | 'description';
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
}: ProjectEditorProps) {
  const localize = useLocalize();
  const updateProject = useUpdateProjectMutation();
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
            : 'flex flex-col gap-3',
        )}
      >
        <span
          className={cn(
            'text-text-secondary flex shrink-0 items-center justify-center',
            isWorkspace
              ? 'bg-surface-secondary size-12 rounded-2xl'
              : 'bg-surface-tertiary h-11 w-11 rounded-xl',
          )}
          aria-hidden="true"
        >
          <Folder className={isWorkspace ? 'size-6' : 'size-5'} aria-hidden="true" />
        </span>
        <div className="w-full min-w-0">
          <Label htmlFor={nameId} className="sr-only">
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
            variant={isWorkspace ? 'title' : 'title-sm'}
            className="w-full max-w-full min-w-0 overflow-hidden wrap-anywhere"
          />
          {errors.name ? (
            <p id={nameErrorId} role="alert" className="text-text-destructive mt-1 text-xs">
              {errors.name.message}
            </p>
          ) : null}
        </div>
        <div className={cn('w-full min-w-0', isWorkspace && 'col-span-2')}>
          <Label htmlFor={descriptionId} className="sr-only">
            {localize('com_ui_description')} {localize('com_ui_optional')}
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
              isWorkspace ? 'h-24 max-h-32' : 'h-20 max-h-24',
            )}
          />
          {errors.description ? (
            <p id={descriptionErrorId} role="alert" className="text-text-destructive mt-1 text-xs">
              {errors.description.message}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={isBusy}>
          {localize('com_ui_cancel')}
        </Button>
        <Button
          type="submit"
          variant="submit"
          size="sm"
          disabled={isBusy}
          aria-label={localize('com_ui_save')}
        >
          {isBusy ? <Spinner className="size-4" /> : localize('com_ui_save')}
        </Button>
      </div>
    </form>
  );
}
