import { SelectDropDown } from '@librechat/client';
import type { TModelSelectProps } from '~/common';
import SelectDropDownPop from '~/components/Input/ModelSelect/SelectDropDownPop';
import { cn, cardStyle } from '~/utils';

export default function OpenAI({
  conversation,
  setOption,
  models,
  showAbove = true,
  popover = false,
}: TModelSelectProps) {
  const Menu = popover ? SelectDropDownPop : SelectDropDown;
  return (
    <Menu
      value={conversation?.model ?? ''}
      setValue={setOption('model')}
      availableValues={models}
      showAbove={showAbove}
      showLabel={false}
      className={cn(
        cardStyle,
        'z-50 flex h-[2.5rem] w-48 min-w-48 flex-none items-center justify-center px-4 hover:cursor-pointer',
      )}
    />
  );
}
