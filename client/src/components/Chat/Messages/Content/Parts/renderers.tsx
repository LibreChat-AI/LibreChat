import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent, TMessage } from 'librechat-data-provider';
import type { MessagePartsMarkdownProps } from '~/hooks/Chat/contract';
import MessageIcon from '~/components/Share/MessageIcon';
import { setAppPartRenderers } from './slots';
import MarkdownLite from '../MarkdownLite';
import Markdown from '../Markdown';

const agentMessage = { endpoint: EModelEndpoint.agents, isCreatedByUser: false } as TMessage;

setAppPartRenderers({
  renderMarkdown: ({ content, variant, isLatestMessage }: MessagePartsMarkdownProps) =>
    variant === 'lite' ? (
      <MarkdownLite content={content} />
    ) : (
      <Markdown content={content} isLatestMessage={isLatestMessage} />
    ),
  renderAgentIcon: (agent: Agent | undefined) => (
    <MessageIcon message={agentMessage} agent={agent} />
  ),
});
