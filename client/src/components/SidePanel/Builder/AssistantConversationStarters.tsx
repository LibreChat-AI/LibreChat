import React, { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import { Transition } from 'react-transition-group';
import { Constants } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

interface AssistantConversationStartersProps {
  field: {
    value: string[];
    onChange: (value: string[]) => void;
  };
  inputClass: string;
  labelClass: string;
}

const AssistantConversationStarters: React.FC<AssistantConversationStartersProps> = ({
  field,
  inputClass,
  labelClass,
}) => {
  const localize = useLocalize();
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const nodeRef = useRef(null);
  const [newStarter, setNewStarter] = useState('');

  const handleAddStarter = () => {
    if (newStarter.trim() && field.value.length < Constants.MAX_CONVO_STARTERS) {
      const newValues = [newStarter, ...field.value];
      field.onChange(newValues);
      setNewStarter('');
    }
  };

  const handleDeleteStarter = (index: number) => {
    const newValues = field.value.filter((_, i) => i !== index);
    field.onChange(newValues);
  };
  const triggerShake = (element: HTMLElement) => {
    element.classList.remove('shake');
    void element.offsetWidth;
    element.classList.add('shake');
    setTimeout(() => {
      element.classList.remove('shake');
    }, 200);
  };

  const hasReachedMax = field.value.length >= Constants.MAX_CONVO_STARTERS;

  const addConversationStarterLabel = hasReachedMax
    ? localize('com_assistants_max_starters_reached')
    : localize('com_ui_add');

  return (
    <div className="relative">
      <label className={labelClass} htmlFor="conversation_starters">
        {localize('com_assistants_conversation_starters')}
      </label>
      <div className="mt-4 space-y-2">
        {/* Persistent starter, used for creating only */}
        <div className="relative">
          <input
            ref={(el) => (inputRefs.current[0] = el)}
            value={newStarter}
            maxLength={64}
            className={`${inputClass} pr-10`}
            type="text"
            placeholder={
              hasReachedMax
                ? localize('com_assistants_max_starters_reached')
                : localize('com_assistants_conversation_starters_placeholder')
            }
            onChange={(e) => setNewStarter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (hasReachedMax) {
                  triggerShake(e.currentTarget);
                } else {
                  handleAddStarter();
                }
              }
            }}
          />
          <Transition
            nodeRef={nodeRef}
            in={field.value.length < Constants.MAX_CONVO_STARTERS}
            timeout={200}
            unmountOnExit
          >
            {(state: string) => (
              <div
                ref={nodeRef}
                className={`absolute top-1 right-1 ${
                  state === 'entering'
                    ? 'transition-none'
                    : 'transition-opacity duration-200 ease-in-out'
                } ${state === 'entering' || state === 'entered' ? 'opacity-100' : 'opacity-0'}`}
              >
                <TooltipAnchor
                  side="top"
                  description={addConversationStarterLabel}
                  aria-label={addConversationStarterLabel}
                  className="hover:bg-surface-hover flex size-7 items-center justify-center rounded-lg transition-colors duration-200"
                  onClick={handleAddStarter}
                  disabled={hasReachedMax}
                >
                  <Plus className="size-4" aria-hidden="true" />
                </TooltipAnchor>
              </div>
            )}
          </Transition>
        </div>
        {field.value.map((starter, index) => (
          <div key={index} className="relative">
            <input
              ref={(el) => (inputRefs.current[index + 1] = el)}
              value={starter}
              onChange={(e) => {
                const newValue = [...field.value];
                newValue[index] = e.target.value;
                field.onChange(newValue);
              }}
              className={`${inputClass} pr-10`}
              type="text"
              maxLength={64}
            />
            <TooltipAnchor
              side="top"
              description={localize('com_ui_delete')}
              aria-label={localize('com_ui_delete')}
              className="hover:bg-surface-hover absolute top-1 right-1 flex size-7 items-center justify-center rounded-lg transition-colors duration-200"
              onClick={() => handleDeleteStarter(index)}
            >
              <X className="size-4" aria-hidden="true" />
            </TooltipAnchor>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AssistantConversationStarters;
