import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent, TMessage } from 'librechat-data-provider';
import type {
  MessagePartsImageProps,
  MessagePartsMarkdownProps,
  MessagePartsFilePreviewProps,
} from '~/hooks/Chat/contract';
import MessageIcon from '~/components/Share/MessageIcon';
import FilePreviewDialog from '../FilePreviewDialog';
import { setAppPartRenderers } from './slots';
import MarkdownLite from '../MarkdownLite';
import Markdown from '../Markdown';
import Image from '../Image';

const agentMessage = { endpoint: EModelEndpoint.agents, isCreatedByUser: false } as TMessage;

setAppPartRenderers({
  renderMarkdown: ({
    content,
    variant,
    isLatestMessage,
    codeExecution,
  }: MessagePartsMarkdownProps) =>
    variant === 'lite' ? (
      <MarkdownLite content={content} codeExecution={codeExecution} />
    ) : (
      <Markdown content={content} isLatestMessage={isLatestMessage} />
    ),
  renderAgentIcon: (agent: Agent | undefined) => (
    <MessageIcon message={agentMessage} agent={agent} />
  ),
  renderImage: (props: MessagePartsImageProps) => <Image {...props} />,
  renderFilePreview: (props: MessagePartsFilePreviewProps) => <FilePreviewDialog {...props} />,
});
