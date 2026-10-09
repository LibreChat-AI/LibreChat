import { memo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import supersub from 'remark-supersub';
import { Check, SquarePen } from 'lucide';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { Controller, useFormContext } from 'react-hook-form';
import { TextareaAutosize, Button, MorphIcon, TooltipAnchor } from '@librechat/client';
import type { RegisterOptions } from 'react-hook-form';
import type { PluggableList } from 'unified';
import { codeNoExecution } from '~/components/Chat/Messages/Content/MarkdownComponents';
import { cn, langSubset } from '~/utils';
import { useLocalize } from '~/hooks';

const REMARK_PLUGINS: PluggableList = [
  supersub,
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
];

const REHYPE_PLUGINS: PluggableList = [
  [rehypeKatex],
  [
    rehypeHighlight,
    {
      detect: true,
      ignoreMissing: true,
      subset: langSubset,
    },
  ],
];

const MARKDOWN_COMPONENTS = { code: codeNoExecution };

interface SkillContentEditorProps {
  name: string;
  isEditing: boolean;
  setIsEditing: React.Dispatch<React.SetStateAction<boolean>>;
  rules?: RegisterOptions;
}

const SkillContentEditor: React.FC<SkillContentEditorProps> = ({
  name,
  isEditing,
  setIsEditing,
  rules,
}) => {
  const localize = useLocalize();
  const {
    control,
    formState: { errors },
  } = useFormContext();

  return (
    <div className="flex max-h-[85vh] flex-col sm:max-h-[85vh]">
      <h2 className="sr-only">{localize('com_ui_skill_content')}</h2>
      <div
        className={cn(
          'border-border-medium relative w-full flex-1 overflow-auto rounded-xl border p-3 text-left transition-all duration-200 sm:p-4',
          isEditing ? '' : 'hover:bg-surface-tertiary cursor-pointer',
        )}
      >
        <div className="absolute top-2 right-2 z-10">
          <TooltipAnchor
            description={isEditing ? localize('com_ui_save') : localize('com_ui_edit')}
            render={
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setIsEditing((prev) => !prev)}
                aria-label={isEditing ? localize('com_ui_save') : localize('com_ui_edit')}
                className="hover:bg-surface-tertiary size-8 p-0"
              >
                <MorphIcon
                  icon={isEditing ? Check : SquarePen}
                  className="text-text-secondary size-4"
                />
              </Button>
            }
          />
        </div>
        {!isEditing && (
          <button
            type="button"
            aria-label={localize('com_ui_edit')}
            className="focus-visible:ring-ring-primary absolute inset-0 z-10 rounded-xl focus:outline-hidden focus-visible:ring-2"
            onClick={() => setIsEditing(true)}
          />
        )}
        <Controller
          name={name}
          control={control}
          rules={rules}
          render={({ field }) =>
            isEditing ? (
              <TextareaAutosize
                focusOutline="hidden"
                {...field}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                className="text-text-primary placeholder:text-text-secondary focus-visible:ring-ring-primary w-full resize-none overflow-y-auto bg-transparent font-mono text-sm leading-relaxed focus-visible:ring-2 sm:text-base"
                minRows={4}
                maxRows={16}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setIsEditing(false);
                  }
                }}
                placeholder={localize('com_ui_skill_content_placeholder')}
                aria-label={localize('com_ui_skill_content')}
              />
            ) : (
              <div
                className="group/preview relative min-h-[6rem] overflow-y-auto text-sm sm:text-base"
                style={{ maxHeight: '24rem' }}
              >
                {!field.value ? (
                  <p className="text-text-secondary italic">{localize('com_ui_click_to_edit')}</p>
                ) : (
                  <ReactMarkdown
                    /** @ts-ignore - PluggableList vs Pluggable[] shape drift */
                    remarkPlugins={REMARK_PLUGINS}
                    /** @ts-ignore - PluggableList vs Pluggable[] shape drift */
                    rehypePlugins={REHYPE_PLUGINS}
                    components={MARKDOWN_COMPONENTS as unknown as Record<string, React.ElementType>}
                    className="markdown prose dark:prose-invert light text-text-primary w-full break-words"
                  >
                    {field.value}
                  </ReactMarkdown>
                )}
                <div className="pointer-events-none sticky bottom-1/2 z-10 flex translate-y-1/2 items-center justify-center opacity-0 transition-all duration-200 group-hover/preview:opacity-100">
                  <div className="border-border-light bg-surface-primary flex items-center gap-2 rounded-lg border px-3 py-1.5 shadow-md">
                    <MorphIcon icon={SquarePen} className="text-text-secondary size-4" />
                    <span className="text-text-primary text-sm font-medium">
                      {localize('com_ui_click_to_edit')}
                    </span>
                  </div>
                </div>
              </div>
            )
          }
        />
        {errors[name] && (
          <p className="text-text-destructive mt-1 text-sm" role="alert">
            {errors[name]?.message as string}
          </p>
        )}
      </div>
    </div>
  );
};

export default memo(SkillContentEditor);
