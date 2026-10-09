import { SelectDropDown } from '@librechat/client';
import type { TModelSelectProps } from '~/common';
import SelectDropDownPop from '~/components/Input/ModelSelect/SelectDropDownPop';
import { cn, cardStyle } from '~/utils';

export default function ChatGPT({
  conversation,
  setOption,
  models,
  showAbove,
  popover = false,
}: TModelSelectProps) {
  if (!conversation) {
    return null;
  }
  const { conversationId, model } = conversation;
  if (conversationId !== 'new') {
    return null;
  }
  const Menu = popover ? SelectDropDownPop : SelectDropDown;
  return (
    <Menu
      value={model ?? ''}
      setValue={setOption('model')}
      availableValues={models}
      showAbove={showAbove}
      showLabel={false}
      className={cn(
        cardStyle,
        'z-50 flex h-[2.5rem] w-60 min-w-48 flex-none items-center justify-center px-4 ring-0 hover:cursor-pointer',
      )}
    />
  );
}
