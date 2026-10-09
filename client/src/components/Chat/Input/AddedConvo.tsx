import { useMemo } from 'react';
import { isAgentsEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import { useGetEndpointsQuery } from '~/data-provider';
import { EndpointIcon } from '~/components/Endpoints';
import { useAgentsMapContext } from '~/Providers';
import { useLocalize } from '~/hooks';

export default function AddedConvo({
  addedConvo,
  setAddedConvo,
}: {
  addedConvo: TConversation | null;
  setAddedConvo: SetterOrUpdater<TConversation | null>;
}) {
  const agentsMap = useAgentsMapContext();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const localize = useLocalize();
  const title = useMemo(() => {
    // Priority: agent name > modelDisplayLabel > modelLabel > model
    if (isAgentsEndpoint(addedConvo?.endpoint)) {
      const agent = addedConvo?.agent_id ? agentsMap?.[addedConvo.agent_id] : undefined;
      /** Never fall into the model-label chain for agents — it would reveal the
       *  underlying model an agent author may intend to keep private. */
      return `+ ${agent?.name || localize('com_ui_agent')}`;
    }

    const endpointConfig = endpointsConfig?.[addedConvo?.endpoint ?? ''];
    const displayLabel =
      endpointConfig?.modelDisplayLabel || addedConvo?.modelLabel || addedConvo?.model || 'AI';

    return `+ ${displayLabel}`;
  }, [addedConvo, agentsMap, endpointsConfig, localize]);

  if (!addedConvo) {
    return null;
  }
  return (
    <div className="flex items-start gap-4 py-2.5 pr-1.5 pl-3 text-sm">
      <span className="mt-0 flex h-6 w-6 shrink-0 items-center justify-center">
        <div className="icon-md">
          <EndpointIcon
            conversation={addedConvo}
            endpointsConfig={endpointsConfig}
            agentsMap={agentsMap}
            containerClassName="shadow-stroke overflow-hidden rounded-full"
            context="menu-item"
            size={20}
          />
        </div>
      </span>
      <span className="text-text-secondary line-clamp-3 flex-1 py-0.5 font-semibold">{title}</span>
      <button
        className="text-text-secondary shrink-0"
        type="button"
        aria-label="Close added conversation"
        onClick={() => setAddedConvo(null)}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          fill="none"
          viewBox="0 0 24 24"
          className="icon-lg"
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M7.293 7.293a1 1 0 0 1 1.414 0L12 10.586l3.293-3.293a1 1 0 1 1 1.414 1.414L13.414 12l3.293 3.293a1 1 0 0 1-1.414 1.414L12 13.414l-3.293 3.293a1 1 0 0 1-1.414-1.414L10.586 12 7.293 8.707a1 1 0 0 1 0-1.414"
            clipRule="evenodd"
          ></path>
        </svg>
      </button>
    </div>
  );
}
