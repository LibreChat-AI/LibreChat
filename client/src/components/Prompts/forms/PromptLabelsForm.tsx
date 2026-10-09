import { useState } from 'react';
import { Input } from '@librechat/client';
import { Cross1Icon } from '@radix-ui/react-icons';
import type { TPrompt } from 'librechat-data-provider';
import { useUpdatePromptLabels } from '~/data-provider';
import { useLocalize } from '~/hooks';

const PromptLabelsForm = ({ selectedPrompt }: { selectedPrompt?: TPrompt }) => {
  const localize = useLocalize();
  const [labelInput, setLabelInput] = useState<string>('');
  const [labels, setLabels] = useState<string[]>([]);
  const updatePromptLabelsMutation = useUpdatePromptLabels();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLabelInput(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Ignore the Enter that commits an IME composition (see useTextarea.ts).
    if (
      e.key === 'Enter' &&
      !(e.nativeEvent.isComposing || e.keyCode === 229) &&
      labelInput.trim()
    ) {
      const newLabels = [...labels, labelInput.trim()];
      setLabels(newLabels);
      setLabelInput('');
      updatePromptLabelsMutation.mutate({
        id: selectedPrompt?._id || '',
        payload: { labels: newLabels },
      });
    }
  };

  return (
    <>
      <Input
        type="text"
        className="mb-4"
        placeholder={`+ ${localize('com_ui_add_labels')}`}
        value={labelInput}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        aria-label={localize('com_ui_add_labels')}
      />
      <h3 className="rounded-t-lg border border-border-medium px-4 text-base font-semibold text-text-primary">
        {localize('com_ui_labels')}
      </h3>
      <div className="mb-4 flex w-full flex-row flex-wrap rounded-b-lg border border-border-medium p-4">
        {labels.length ? (
          labels.map((label, index) => (
            <span
              className="mb-1 mr-1 flex items-center gap-x-2 rounded-full border px-2"
              key={index}
            >
              {label}
              <button
                type="button"
                onClick={() => {
                  const newLabels = labels.filter((l) => l !== label);
                  setLabels(newLabels);
                  updatePromptLabelsMutation.mutate({
                    id: selectedPrompt?._id || '',
                    payload: { labels: newLabels },
                  });
                }}
                className="cursor-pointer"
                aria-label={`${localize('com_ui_delete')} ${label}`}
              >
                <Cross1Icon aria-hidden="true" />
              </button>
            </span>
          ))
        ) : (
          <span className="rounded-full border px-2">{localize('com_ui_no_labels')}</span>
        )}
      </div>
    </>
  );
};

export default PromptLabelsForm;
