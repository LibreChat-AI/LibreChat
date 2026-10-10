import React from 'react';
import { useRecoilState } from 'recoil';
import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';
import store from '~/store';

const ChatDirection = () => {
  const [direction, setDirection] = useRecoilState(store.chatDirection);
  const localize = useLocalize();

  const toggleChatDirection = () => {
    setDirection((prev) => (prev === 'LTR' ? 'RTL' : 'LTR'));
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center space-x-2">
        <span id="chat-direction-label">{localize('com_nav_chat_direction')}</span>
      </div>
      <Button
        variant="outline"
        aria-label={localize('com_nav_chat_direction_selected', {
          direction:
            direction === 'LTR'
              ? localize('chat_direction_left_to_right')
              : localize('chat_direction_right_to_left'),
        })}
        onClick={toggleChatDirection}
        data-testid="chatDirection"
      >
        {direction.toLowerCase()}
      </Button>
    </div>
  );
};

export default ChatDirection;
