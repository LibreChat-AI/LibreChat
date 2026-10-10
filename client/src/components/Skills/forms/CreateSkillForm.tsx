import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useForm, Controller, FormProvider } from 'react-hook-form';
import { Input, Label, Button, TextareaAutosize, useToastContext } from '@librechat/client';
import {
  InvocationMode,
  SKILL_NAME_PATTERN,
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from 'librechat-data-provider';
import type { TSkill, TCreateSkill, TSkillWarning } from 'librechat-data-provider';
import { useCreateSkillMutation } from '~/data-provider';
import SkillContentEditor from './SkillContentEditor';
import CategorySelector from './CategorySelector';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const DEFAULT_BODY = `# Overview

Describe what this skill does and how it should be applied.

## When to use

- List concrete signals that should trigger this skill
- Add examples that make the trigger unambiguous

## How to apply

Walk through the steps the agent should take.
`;

interface CreateSkillFormValues {
  name: string;
  description: string;
  body: string;
  category: string;
  invocationMode: InvocationMode;
}

const DEFAULT_VALUES: CreateSkillFormValues = {
  name: '',
  description: '',
  body: DEFAULT_BODY,
  category: '',
  invocationMode: InvocationMode.auto,
};

interface CreateSkillFormProps {
  /**
   * Pre-populated field values — used by the upload path to seed the form
   * with parsed SKILL.md frontmatter. Shape is a subset of the form values
   * (partial) because the upload parser may only extract `name` +
   * `description`; `invocationMode` is accepted for shape compatibility
   * with the original UI PR but ignored for now (the backend doesn't
   * persist it yet).
   */
  defaultValues?: Partial<CreateSkillFormValues> & { invocationMode?: unknown };
  onCancel?: () => void;
  onSuccess?: (skill: TSkill) => void;
}

export default function CreateSkillForm({
  defaultValues,
  onCancel,
  onSuccess,
}: CreateSkillFormProps) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const [isEditingContent, setIsEditingContent] = useState(true);

  const methods = useForm<CreateSkillFormValues>({
    defaultValues: { ...DEFAULT_VALUES, ...defaultValues },
    mode: 'onChange',
  });
  const {
    control,
    handleSubmit,
    setError,
    formState: { isSubmitting, isValid, errors },
  } = methods;

  const createSkill = useCreateSkillMutation({
    onSuccess: (skill) => {
      const warnings: TSkillWarning[] | undefined = skill.warnings;
      showToast({
        status: warnings && warnings.length > 0 ? 'warning' : 'success',
        message: localize('com_ui_skill_created'),
      });
      if (onSuccess) {
        onSuccess(skill);
      } else {
        navigate(`/skills/${skill._id}`);
      }
    },
    onError: (error: unknown) => {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        localize('com_ui_skill_create_error');
      showToast({ status: 'error', message });
    },
  });

  // `useCallback` would be a no-op here: `createSkill` is a React Query
  // mutation result with an unstable identity, and `handleSubmit` from
  // react-hook-form doesn't use `onSubmit` as a dependency anywhere.
  const onSubmit = (values: CreateSkillFormValues) => {
    if (createSkill.isLoading) {
      return;
    }
    const payload: TCreateSkill = {
      name: values.name.trim(),
      description: values.description.trim(),
      body: values.body,
      category: values.category || undefined,
      // `invocationMode` is deliberately NOT forwarded — phase 1 backend
      // doesn't persist it. Kept in form state only so the picker has a
      // selection.
    };

    if (!SKILL_NAME_PATTERN.test(payload.name)) {
      setError('name', { message: localize('com_ui_skill_name_invalid') });
      return;
    }

    createSkill.mutate(payload);
  };

  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    } else {
      navigate(-1);
    }
  };

  const createDisabled = !isValid || isSubmitting || createSkill.isLoading;

  return (
    <FormProvider {...methods}>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="w-full px-4 py-2"
        aria-label={localize('com_ui_skill_create_title')}
      >
        <h1 className="sr-only">{localize('com_ui_skill_create_title')}</h1>
        <div className="mb-1 flex flex-col items-center justify-between font-bold sm:text-xl md:mb-0 md:text-2xl">
          <div className="flex w-full flex-col items-center justify-between sm:flex-row">
            <Controller
              name="name"
              control={control}
              rules={{
                required: localize('com_ui_skill_name_required'),
                pattern: {
                  value: SKILL_NAME_PATTERN,
                  message: localize('com_ui_skill_name_invalid'),
                },
                maxLength: {
                  value: SKILL_NAME_MAX_LENGTH,
                  message: localize('com_ui_skill_name_too_long', {
                    0: String(SKILL_NAME_MAX_LENGTH),
                  }),
                },
              }}
              render={({ field }) => (
                <div className="relative mb-1 flex w-full flex-col sm:w-auto md:mb-0">
                  <Input
                    {...field}
                    id="skill-name"
                    type="text"
                    className="peer border-border-medium text-text-primary mr-2 w-full border p-2 text-2xl"
                    placeholder=" "
                    tabIndex={0}
                    aria-label={localize('com_ui_name')}
                    aria-required="true"
                    aria-invalid={errors.name ? 'true' : 'false'}
                    aria-describedby={errors.name ? 'skill-name-error' : undefined}
                  />
                  <label
                    htmlFor="skill-name"
                    className="bg-surface-primary-alt text-text-secondary peer-focus:text-text-primary pointer-events-none absolute -top-1 left-3 origin-[0] translate-y-3 scale-100 rounded px-1 text-base transition-transform duration-200 peer-placeholder-shown:translate-y-3 peer-placeholder-shown:scale-100 peer-focus:-translate-y-2 peer-focus:scale-75 peer-[:not(:placeholder-shown)]:-translate-y-2 peer-[:not(:placeholder-shown)]:scale-75"
                  >
                    {localize('com_ui_name')}*
                  </label>
                  <div
                    id="skill-name-error"
                    className={cn(
                      'text-text-destructive mt-1 w-56 text-sm',
                      errors.name ? 'visible h-auto' : 'invisible h-0',
                    )}
                    role={errors.name ? 'alert' : undefined}
                  >
                    {errors.name ? errors.name.message : ' '}
                  </div>
                </div>
              )}
            />
            <div className="flex items-center gap-2">
              <CategorySelector />
            </div>
          </div>
        </div>

        <div className="flex w-full flex-col gap-4 md:mt-[1.075rem]">
          <Controller
            name="description"
            control={control}
            rules={{
              required: localize('com_ui_skill_description_required'),
              maxLength: {
                value: SKILL_DESCRIPTION_MAX_LENGTH,
                message: localize('com_ui_skill_description_too_long', {
                  0: String(SKILL_DESCRIPTION_MAX_LENGTH),
                }),
              },
            }}
            render={({ field }) => (
              <div className="flex flex-col">
                <Label
                  htmlFor="skill-description"
                  className="text-text-secondary mb-1 text-sm font-medium"
                >
                  {localize('com_ui_description')}
                  <span className="text-text-destructive ml-0.5">*</span>
                </Label>
                <TextareaAutosize
                  focusOutline="hidden"
                  {...field}
                  id="skill-description"
                  minRows={2}
                  maxRows={6}
                  placeholder={localize('com_ui_skill_description_placeholder')}
                  aria-label={localize('com_ui_description')}
                  aria-invalid={errors.description ? 'true' : 'false'}
                  aria-describedby={errors.description ? 'skill-description-error' : undefined}
                  className="border-border-medium text-text-primary placeholder:text-text-secondary focus-visible:ring-ring-primary w-full resize-none rounded-xl border bg-transparent p-3 text-sm focus-visible:ring-2"
                />
                <p className="text-text-secondary mt-1 text-xs">
                  {localize('com_ui_skill_description_field_hint')}
                </p>
                {errors.description && (
                  <p
                    id="skill-description-error"
                    className="text-text-destructive mt-1 text-sm"
                    role="alert"
                  >
                    {errors.description.message}
                  </p>
                )}
              </div>
            )}
          />

          <SkillContentEditor
            name="body"
            isEditing={isEditingContent}
            setIsEditing={setIsEditingContent}
          />

          {createSkill.error != null && (
            <div
              role="alert"
              className="border-status-error-border bg-status-error-subtle text-text-destructive flex items-start gap-2 rounded-md border p-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{localize('com_ui_skill_create_error')}</span>
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={handleCancel}>
              {localize('com_ui_cancel')}
            </Button>
            <Button
              aria-label={localize('com_ui_skill_create_title')}
              type="submit"
              disabled={createDisabled}
              aria-disabled={createDisabled || undefined}
              className={cn('w-full sm:w-auto', createDisabled && 'opacity-50')}
            >
              {localize('com_ui_skill_create_title')}
            </Button>
          </div>
        </div>
      </form>
    </FormProvider>
  );
}
