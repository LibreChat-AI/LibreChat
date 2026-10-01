import { useEffect } from 'react';
import { FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useForm, Controller, FormProvider } from 'react-hook-form';
import { LocalStorageKeys, PermissionTypes, Permissions } from 'librechat-data-provider';
import { Button, Spinner, TextareaAutosize, Input, useMediaQuery } from '@librechat/client';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import VariablesDropdown from '../editor/VariablesDropdown';
import CategorySelector from '../fields/CategorySelector';
import PromptVariables from '../display/PromptVariables';
import { usePromptGroupsContext } from '~/Providers';
import { useLocalize, useHasAccess } from '~/hooks';
import { useCreatePrompt } from '~/data-provider';
import Description from '../fields/Description';
import Command from '../fields/Command';
import { cn } from '~/utils';

type CreateFormValues = {
  name: string;
  prompt: string;
  type: 'text' | 'chat';
  category: string;
  oneliner?: string;
  command?: string;
};

const defaultPrompt: CreateFormValues = {
  name: '',
  prompt: '',
  type: 'text',
  category: '',
  oneliner: undefined,
  command: undefined,
};

const CreatePromptForm = ({
  defaultValues = defaultPrompt,
  onSuccess,
  isDialog = false,
}: {
  defaultValues?: CreateFormValues;
  onSuccess?: (groupId: string) => void;
  /** Drops the page-level chrome (sidebar toggle, page padding) when hosted in a dialog */
  isDialog?: boolean;
}) => {
  const localize = useLocalize();
  const navigate = useNavigate();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const { hasAccess: hasUseAccess } = usePromptGroupsContext() ?? {};
  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.CREATE,
  });
  const hasAccess = hasUseAccess && hasCreateAccess;

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    if (!hasAccess && !onSuccess) {
      timeoutId = setTimeout(() => {
        navigate('/c/new');
      }, 1000);
    }
    return () => {
      clearTimeout(timeoutId);
    };
  }, [hasAccess, navigate, onSuccess]);

  const methods = useForm({
    defaultValues: {
      ...defaultValues,
      category: localStorage.getItem(LocalStorageKeys.LAST_PROMPT_CATEGORY) ?? '',
    },
  });

  const {
    watch,
    control,
    handleSubmit,
    formState: { isDirty, isSubmitting, errors, isValid },
  } = methods;

  const createPromptMutation = useCreatePrompt({
    onSuccess: (response) => {
      const groupId = response.prompt.groupId;
      if (onSuccess && groupId) {
        onSuccess(groupId);
      } else {
        navigate(`/prompts/${groupId}`, { replace: true });
      }
    },
  });

  const promptText = watch('prompt');
  const isCreating = createPromptMutation.isLoading;
  const isBlocked = !isDirty || isSubmitting || !isValid || isCreating;
  /** Floating labels notch out the surface behind them: the dialog sits on `surface-primary`, the page on `presentation` */
  const labelBgClassName = isDialog ? 'bg-surface-primary' : 'bg-surface-primary-alt';

  const onSubmit = (data: CreateFormValues) => {
    const { name, category, oneliner, command, ...rest } = data;
    const groupData = { name, category } as Pick<
      CreateFormValues,
      'name' | 'category' | 'oneliner' | 'command'
    >;
    if ((oneliner?.length ?? 0) > 0) {
      groupData.oneliner = oneliner;
    }
    if ((command?.length ?? 0) > 0) {
      groupData.command = command;
    }
    createPromptMutation.mutate({
      prompt: rest,
      group: groupData,
    });
  };

  if (!hasAccess) {
    return null;
  }

  return (
    <FormProvider {...methods}>
      <form onSubmit={handleSubmit(onSubmit)} className={cn('w-full', !isDialog && 'px-4 py-2')}>
        {!isDialog && <h1 className="sr-only">{localize('com_ui_create_prompt_page')}</h1>}
        {isSmallScreen ? (
          <div className="mb-2 flex items-center justify-between gap-2">
            {!isDialog && <OpenSidebar />}
            <CategorySelector portal={!isDialog} />
          </div>
        ) : null}
        <div className="mb-1 flex flex-col items-center justify-between font-bold sm:text-xl md:mb-0 md:text-2xl">
          <div className="flex w-full flex-col items-center justify-between sm:flex-row">
            <Controller
              name="name"
              control={control}
              rules={{ required: localize('com_ui_prompt_name_required') }}
              render={({ field }) => (
                <div className="relative mb-1 flex w-full flex-col sm:w-auto md:mb-0">
                  <Input
                    {...field}
                    id="prompt-name"
                    type="text"
                    className="peer border-border-medium text-text-primary mr-2 w-full border p-2 text-2xl"
                    placeholder=" "
                    tabIndex={0}
                    aria-label={localize('com_ui_prompt_name')}
                    aria-required="true"
                  />
                  <label
                    htmlFor="prompt-name"
                    className={cn(
                      'text-text-secondary peer-focus:text-text-primary pointer-events-none absolute -top-1 left-3 origin-[0] translate-y-3 scale-100 rounded px-1 text-base transition-transform duration-200 peer-placeholder-shown:translate-y-3 peer-placeholder-shown:scale-100 peer-focus:-translate-y-2 peer-focus:scale-75 peer-[:not(:placeholder-shown)]:-translate-y-2 peer-[:not(:placeholder-shown)]:scale-75',
                      labelBgClassName,
                    )}
                  >
                    {localize('com_ui_prompt_name')}*
                  </label>
                  <div
                    className={cn(
                      'text-text-destructive mt-1 w-56 text-sm',
                      errors.name ? 'visible h-auto' : 'invisible h-0',
                    )}
                  >
                    {errors.name ? errors.name.message : ' '}
                  </div>
                </div>
              )}
            />
            {!isSmallScreen && (
              <div>
                <CategorySelector portal={!isDialog} />
              </div>
            )}
          </div>
        </div>
        <div className="flex w-full flex-col gap-4 md:mt-[1.075rem]">
          <div className="flex flex-col">
            <header className="border-border-medium flex items-center justify-between rounded-t-xl border bg-transparent p-2">
              <div className="ml-1 flex items-center gap-2">
                <FileText className="text-text-secondary size-4" aria-hidden="true" />
                <h2 className="text-text-primary text-sm font-semibold">
                  {localize('com_ui_prompt_text')}*
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <VariablesDropdown fieldName="prompt" portal={!isDialog} />
              </div>
            </header>
            <div className="border-border-medium min-h-32 rounded-b-xl border border-t-0 p-3 sm:p-4">
              <Controller
                name="prompt"
                control={control}
                rules={{ required: localize('com_ui_prompt_text_required') }}
                render={({ field }) => (
                  <div>
                    <TextareaAutosize
                      focusOutline="hidden"
                      {...field}
                      className="text-text-primary placeholder:text-text-tertiary focus-visible:ring-ring-primary w-full resize-none overflow-y-auto bg-transparent font-mono text-sm leading-relaxed focus-visible:ring-2 sm:text-base"
                      minRows={isDialog ? 10 : 4}
                      maxRows={16}
                      tabIndex={0}
                      placeholder={localize('com_ui_prompt_input')}
                      aria-label={localize('com_ui_prompt_input_field')}
                      aria-required="true"
                    />
                    <div
                      className={cn(
                        'text-text-destructive mt-1 text-sm',
                        errors.prompt ? 'visible h-auto' : 'invisible h-0',
                      )}
                    >
                      {errors.prompt ? errors.prompt.message : ' '}
                    </div>
                  </div>
                )}
              />
            </div>
          </div>
          <PromptVariables promptText={promptText} />
          <Description
            onValueChange={(value) => methods.setValue('oneliner', value)}
            tabIndex={0}
            labelBgClassName={labelBgClassName}
          />
          <Command
            onValueChange={(value) => methods.setValue('command', value)}
            tabIndex={0}
            labelBgClassName={labelBgClassName}
          />
          <div className="mt-4 flex justify-end">
            <Button
              variant="submit"
              aria-label={localize('com_ui_create_prompt')}
              className={cn('w-full gap-2 sm:w-auto', isBlocked && 'opacity-50')}
              tabIndex={0}
              type="submit"
              aria-disabled={isBlocked || undefined}
              aria-busy={isCreating || undefined}
              onClick={(e: React.MouseEvent) => {
                if (isBlocked) {
                  e.preventDefault();
                }
              }}
            >
              {isCreating && <Spinner className="size-4" aria-hidden="true" />}
              {localize('com_ui_create_prompt')}
            </Button>
          </div>
        </div>
      </form>
    </FormProvider>
  );
};

export default CreatePromptForm;
