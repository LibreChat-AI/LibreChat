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
          'relative w-full flex-1 overflow-auto rounded-xl border border-border-medium p-3 text-left transition-all duration-200 sm:p-4',
          isEditing ? '' : 'cursor-pointer hover:bg-surface-tertiary',
        )}
      >
        <div className="absolute right-2 top-2 z-10">
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
                className="size-8 p-0 hover:bg-surface-tertiary"
              >
                <MorphIcon
                  icon={isEditing ? Check : SquarePen}
                  className="size-4 text-text-secondary"
                />
              </Button>
            }
          />
        </div>
        {!isEditing && (
          <button
            type="button"
            aria-label={localize('com_ui_edit')}
            className="absolute inset-0 z-10 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
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
                {...field}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                className="w-full resize-none overflow-y-auto bg-transparent font-mono text-sm leading-relaxed text-text-primary placeholder:text-text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary sm:text-base"
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
                  <p className="italic text-text-secondary">{localize('com_ui_click_to_edit')}</p>
                ) : (
                  <ReactMarkdown
                    /** @ts-ignore - PluggableList vs Pluggable[] shape drift */
                    remarkPlugins={REMARK_PLUGINS}
                    /** @ts-ignore - PluggableList vs Pluggable[] shape drift */
                    rehypePlugins={REHYPE_PLUGINS}
                    components={MARKDOWN_COMPONENTS as unknown as Record<string, React.ElementType>}
                    className="markdown prose dark:prose-invert light w-full break-words text-text-primary"
                  >
                    {field.value}
                  </ReactMarkdown>
                )}
                <div className="pointer-events-none sticky bottom-1/2 z-10 flex translate-y-1/2 items-center justify-center opacity-0 transition-all duration-200 group-hover/preview:opacity-100">
                  <div className="flex items-center gap-2 rounded-lg border border-border-light bg-surface-primary px-3 py-1.5 shadow-md">
                    <MorphIcon icon={SquarePen} className="size-4 text-text-secondary" />
                    <span className="text-sm font-medium text-text-primary">
                      {localize('com_ui_click_to_edit')}
                    </span>
                  </div>
                </div>
              </div>
            )
          }
        />
        {errors[name] && (
          <p className="mt-1 text-sm text-text-destructive" role="alert">
            {errors[name]?.message as string}
          </p>
        )}
      </div>
    </div>
  );
};

export default memo(SkillContentEditor);
