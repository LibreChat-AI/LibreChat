import { useAtom } from 'jotai';
import { Dropdown } from '@librechat/client';
import type { ChatDirection as TChatDirection } from '~/store/chatDirection';
import { chatDirectionAtom } from '~/store/chatDirection';
import { useLocalize } from '~/hooks';

const ChatDirection = () => {
  const localize = useLocalize();
  const [direction, setDirection] = useAtom(chatDirectionAtom);

  const options = [
    { value: 'auto', label: localize('com_ui_auto') },
    { value: 'ltr', label: localize('chat_direction_left_to_right') },
    { value: 'rtl', label: localize('chat_direction_right_to_left') },
  ];

  const labelId = 'chat-direction-label';

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div id={labelId}>{localize('com_nav_chat_direction')}</div>
      <Dropdown
        value={direction}
        options={options}
        onChange={(value: string) => setDirection(value as TChatDirection)}
        testId="chatDirection"
        sizeClasses="z-50 w-[9.375rem]"
        className="z-50"
        aria-labelledby={labelId}
      />
    </div>
  );
};

export default ChatDirection;
