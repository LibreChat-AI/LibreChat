import React from 'react';

interface MessageBlockProps {
  message: string;
  'aria-live': 'polite' | 'assertive';
}

const MessageBlock: React.FC<MessageBlockProps> = ({ message, 'aria-live': ariaLive }) => (
  <div className="sr-only" role="log" aria-live={ariaLive}>
    {message}
  </div>
);

export default MessageBlock;
