import React from 'react';
import { Plus, Minus } from 'lucide-react';
import { Button, Label } from '@librechat/client';
import TextareaAutosize from 'react-textarea-autosize';
import type { TExample } from 'librechat-data-provider';
import type { TSetExample } from '~/common';
import { cn, defaultTextProps } from '~/utils/';
import { useLocalize } from '~/hooks';

type TExamplesProps = {
  readonly?: boolean;
  className?: string;
  examples: TExample[];
  setExample: TSetExample;
  addExample: () => void;
  removeExample: () => void;
};

function Examples({ readonly, examples, setExample, addExample, removeExample }: TExamplesProps) {
  const localize = useLocalize();
  return (
    <>
      <div id="examples-grid" className="grid gap-6 sm:grid-cols-2">
        {examples.map((example, idx) => (
          <React.Fragment key={idx}>
            {/* Input */}
            <div
              className={`col-span-${
                examples.length === 1 ? '1' : 'full'
              } flex flex-col items-center justify-start gap-6 sm:col-span-1`}
            >
              <div className="grid w-full items-center gap-2">
                <Label htmlFor={`input-${idx}`} className="text-left text-sm font-medium">
                  {localize('com_ui_input')}{' '}
                  <small className="opacity-40 high-contrast:opacity-100">
                    ({localize('com_endpoint_default_blank')})
                  </small>
                </Label>
                <TextareaAutosize
                  id={`input-${idx}`}
                  disabled={readonly}
                  value={example.input.content || ''}
                  onChange={(e) => setExample(idx, 'input', e.target.value ?? null)}
                  placeholder="Set example input. Example is ignored if empty."
                  className={cn(
                    defaultTextProps,
                    'flex max-h-[138px] min-h-[75px] w-full resize-none px-3 py-2',
                  )}
                />
              </div>
            </div>

            {/* Output */}
            <div
              className={`col-span-${
                examples.length === 1 ? '1' : 'full'
              } flex flex-col items-center justify-start gap-6 sm:col-span-1`}
            >
              <div className="grid w-full items-center gap-2">
                <Label htmlFor={`output-${idx}`} className="text-left text-sm font-medium">
                  {localize('com_endpoint_output')}{' '}
                  <small className="opacity-40 high-contrast:opacity-100">
                    ({localize('com_endpoint_default_blank')})
                  </small>
                </Label>
                <TextareaAutosize
                  id={`output-${idx}`}
                  disabled={readonly}
                  value={example.output.content || ''}
                  onChange={(e) => setExample(idx, 'output', e.target.value ?? null)}
                  placeholder={'Set example output. Example is ignored if empty.'}
                  className={cn(
                    defaultTextProps,
                    'flex max-h-[300px] min-h-[75px] w-full resize-none px-3 py-2',
                  )}
                />
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>
      <div className="flex justify-center">
        <Button
          type="button"
          className="mr-2 mt-1 h-auto items-center justify-center bg-transparent px-3 py-2 text-xs font-medium font-normal text-text-primary hover:bg-surface-hover hover:text-text-primary focus:ring-0 focus:ring-offset-0 dark:focus:outline-none dark:focus:ring-offset-0"
          onClick={removeExample}
        >
          <Minus className="w-[16px]" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          className="mt-1 h-auto items-center justify-center bg-transparent px-3 py-2 text-xs font-medium font-normal text-text-primary hover:bg-surface-hover hover:text-text-primary focus:ring-0 focus:ring-offset-0 dark:focus:outline-none dark:focus:ring-offset-0"
          onClick={addExample}
        >
          <Plus className="w-[16px]" aria-hidden="true" />
        </Button>
      </div>
    </>
  );
}

export default Examples;
