import { memo } from 'react';
import { MessageFiles } from '@librechat/chat/components';
import type { TMessage } from 'librechat-data-provider';
import '~/Providers/MessagePartsHostContext';

const Files = ({ message }: { message?: TMessage }) => <MessageFiles files={message?.files} />;

export default memo(Files);
