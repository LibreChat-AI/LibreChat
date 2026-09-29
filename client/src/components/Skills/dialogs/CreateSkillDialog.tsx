import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import {
  Input,
  Label,
  Button,
  OGDialog,
  OGDialogContent,
  TextareaAutosize,
  useToastContext,
} from '@librechat/client';
import {
  SKILL_NAME_PATTERN,
  SKILL_NAME_MAX_LENGTH,
  SKILL_BODY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from 'librechat-data-provider';
import type { TSkill } from 'librechat-data-provider';
import type { FormEvent } from 'react';
import { useCreateSkillMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface CreateSkillDialogProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  defaultName?: string;
  defaultDescription?: string;
  defaultBody?: string;
  /**
   * Called with the created skill instead of navigating to its page. Lets the
   * dialog be reused in-context (e.g. the agent-builder skill picker) so creating
   * a skill keeps the user in place rather than routing to `/skills/:id`.
   */
  onCreated?: (skill: TSkill) => void;
}

interface FormValues {
  name: string;
  description: string;
  body: string;
}

interface SkillValidationIssue {
  field: string;
  code: string;
}

/**
 * Minimal create-skill dialog matching Claude.ai's "Write skill instructions"
 * modal: name, description, instructions. No category, no invocation mode.
 */
export default function CreateSkillDialog({
  isOpen,
  setIsOpen,
  defaultName = '',
  defaultDescription = '',
  defaultBody = '',
  onCreated,
}: CreateSkillDialogProps) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();

  const {
    register,
    handleSubmit,
    reset,
    formState: { isValid, isSubmitting, errors },
  } = useForm<FormValues>({
    defaultValues: { name: defaultName, description: defaultDescription, body: defaultBody },
    mode: 'onChange',
  });

  const createSkill = useCreateSkillMutation({
    onSuccess: (skill) => {
      showToast({ status: 'success', message: localize('com_ui_skill_created') });
      setIsOpen(false);
      reset();
      if (onCreated) {
        onCreated(skill);
        return;
      }
      navigate(`/skills/${skill._id}`);
    },
    onError: (error: unknown) => {
      const response = (
        error as {
          response?: {
            status?: number;
            data?: { error?: string; message?: string; issues?: SkillValidationIssue[] };
          };
        }
      )?.response;
      const getIssueMessage = ({ field, code }: SkillValidationIssue) => {
        if (field === 'name' && code === 'REQUIRED') {
          return localize('com_ui_skill_name_required');
        }
        if (field === 'name' && code === 'TOO_LONG') {
          return localize('com_ui_skill_name_too_long', { 0: SKILL_NAME_MAX_LENGTH });
        }
        if (field === 'name' && code === 'INVALID_FORMAT') {
          return localize('com_ui_skill_name_invalid');
        }
        if (field === 'name' && (code === 'RESERVED_PREFIX' || code === 'RESERVED_WORD')) {
          return localize('com_ui_skill_name_reserved');
        }
        if (field === 'description' && code === 'REQUIRED') {
          return localize('com_ui_skill_description_required');
        }
        if (field === 'description' && code === 'TOO_LONG') {
          return localize('com_ui_skill_description_too_long', {
            0: SKILL_DESCRIPTION_MAX_LENGTH,
          });
        }
        if (field === 'body' && code === 'TOO_LONG') {
          return localize('com_ui_skill_instructions_too_long', { 0: SKILL_BODY_MAX_LENGTH });
        }
        return localize('com_ui_skill_validation_error');
      };
      const data = response?.data;
      let message = data?.message || localize('com_ui_skill_create_error');
      if (response?.status === 409) {
        message = localize('com_ui_skill_name_exists');
      }
      if (data?.issues?.length) {
        message = data.issues.map(getIssueMessage).join('; ');
      }
      showToast({ status: 'error', message });
    },
  });

  const onSubmit = (data: FormValues) => {
    if (createSkill.isLoading) {
      return;
    }
    createSkill.mutate({
      name: data.name.trim(),
      description: data.description.trim(),
      body: data.body,
    });
  };

  const handleClose = () => {
    setIsOpen(false);
    reset();
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    /**
     * This dialog can be portaled from inside Agent Builder's form. React
     * events still bubble through the component tree across a portal, so an
     * unguarded submit also submits (and prematurely creates) the agent.
     */
    event.stopPropagation();
    return handleSubmit(onSubmit)(event);
  };

  const submitDisabled = !isValid || isSubmitting || createSkill.isLoading;

  return (
    <OGDialog open={isOpen} onOpenChange={setIsOpen}>
      <OGDialogContent className="w-11/12 max-w-5xl overflow-hidden" showCloseButton={false}>
        <form
          onSubmit={handleFormSubmit}
          className="flex max-h-[80vh] min-w-0 flex-col gap-3 overflow-hidden p-1 sm:gap-4 sm:p-2"
        >
          <h2 className="text-lg font-bold text-text-primary">
            {localize('com_ui_skill_write_instructions')}
          </h2>

          {/* Skill name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-skill-name" className="text-sm font-medium text-text-secondary">
              {localize('com_ui_name')}
            </Label>
            <Input
              id="create-skill-name"
              placeholder={localize('com_ui_skill_name_placeholder')}
              aria-invalid={errors.name ? 'true' : 'false'}
              autoComplete="off"
              className="flex h-10 w-full rounded-xl border border-border-medium bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary disabled:cursor-not-allowed disabled:opacity-50"
              {...register('name', {
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
              })}
            />
            {errors.name && <p className="text-xs text-text-destructive">{errors.name.message}</p>}
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="create-skill-description"
              className="text-sm font-medium text-text-secondary"
            >
              {localize('com_ui_description')}
            </label>
            <TextareaAutosize
              id="create-skill-description"
              minRows={2}
              maxRows={4}
              placeholder={localize('com_ui_skill_description_placeholder')}
              aria-label={localize('com_ui_description')}
              aria-invalid={errors.description ? 'true' : 'false'}
              aria-describedby={errors.description ? 'create-skill-description-error' : undefined}
              className="w-full resize-none rounded-xl border border-border-medium bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
              {...register('description', {
                required: localize('com_ui_skill_description_required'),
                maxLength: {
                  value: SKILL_DESCRIPTION_MAX_LENGTH,
                  message: localize('com_ui_skill_description_too_long', {
                    0: String(SKILL_DESCRIPTION_MAX_LENGTH),
                  }),
                },
              })}
            />
            {errors.description && (
              <p
                id="create-skill-description-error"
                className="mt-1 text-sm text-text-destructive"
                role="alert"
              >
                {errors.description.message}
              </p>
            )}
          </div>

          {/* Instructions (body) */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-skill-body" className="text-sm font-medium text-text-secondary">
              {localize('com_ui_skill_instructions')}
            </label>
            <TextareaAutosize
              id="create-skill-body"
              minRows={6}
              maxRows={12}
              placeholder={localize('com_ui_skill_instructions_placeholder')}
              aria-label={localize('com_ui_skill_instructions')}
              className="w-full resize-none rounded-xl border border-border-medium bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
              {...register('body')}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={handleClose}>
              {localize('com_ui_cancel')}
            </Button>
            <Button
              type="submit"
              variant="submit"
              disabled={submitDisabled}
              aria-busy={createSkill.isLoading}
              className={cn(submitDisabled && 'opacity-50')}
            >
              {localize(createSkill.isLoading ? 'com_ui_creating' : 'com_ui_create')}
            </Button>
          </div>
        </form>
      </OGDialogContent>
    </OGDialog>
  );
}
