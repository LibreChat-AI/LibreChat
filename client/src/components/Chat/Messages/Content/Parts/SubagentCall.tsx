import { useCallback } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { AttachmentGroup, SubagentCall as PackageSubagentCall } from '@librechat/chat/components';
import type { SubagentCallProps, SubagentCallContext } from '@librechat/chat/components';
import type { TMessage } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { useMessageContext } from '~/Providers/MessageContext';
import { useShareContext } from '~/Providers/ShareContext';
import MessageIcon from '~/components/Share/MessageIcon';
import { MCPAppViews } from '~/components/MCPUIResource';
import { useLocalize } from '~/hooks';

const agentMessage = { endpoint: EModelEndpoint.agents, isCreatedByUser: false } as TMessage;
const renderAgentIcon: SubagentCallContext['renderAgentIcon'] = (agent) => (
  <MessageIcon message={agentMessage} agent={agent} />
);
const renderAttachments: SubagentCallContext['renderAttachments'] = (attachments) => (
  <>
    <AttachmentGroup attachments={attachments} />
    <MCPAppViews attachments={attachments} />
  </>
);

/** App subscriptions stay here; the package owns the card and its panel behavior. */
export default function SubagentCall(props: SubagentCallProps) {
  const message = useMessageContext();
  const share = useShareContext();
  const agentsMap = useAgentsMapContext();
  const translate = useLocalize();
  const localize = useCallback<SubagentCallContext['localize']>(
    (key, values) => translate(key as TranslationKeys, values),
    [translate],
  );
  return (
    <PackageSubagentCall
      {...props}
      {...share}
      message={message}
      agentsMap={agentsMap}
      localize={localize}
      renderAgentIcon={renderAgentIcon}
      renderAttachments={renderAttachments}
    />
  );
}
