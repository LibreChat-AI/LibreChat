import { AutoHeight as ChatAutoHeight } from '@librechat/chat/components';
import type { ComponentProps } from 'react';

export default function AutoHeight(props: ComponentProps<typeof ChatAutoHeight>) {
  return <ChatAutoHeight {...props} />;
}
