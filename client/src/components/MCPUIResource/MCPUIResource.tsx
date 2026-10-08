import React from 'react';
import { useOptionalMessagesConversation, useOptionalMessagesOperations } from '~/Providers';
import { useConversationUIResources } from '~/hooks/Messages/useConversationUIResources';
import UIResourceRenderer, { isSupportedUIResource } from './Renderer';
import { handleUIAction } from '~/utils';
import { useLocalize } from '~/hooks';

interface MCPUIResourceProps {
  node: {
    properties: {
      resourceId: string;
    };
  };
}

/** Renders an MCP UI resource based on its resource ID. Works in chat, share, and search views. */
export function MCPUIResource(props: MCPUIResourceProps) {
  const { resourceId } = props.node.properties;
  const localize = useLocalize();
  const { ask } = useOptionalMessagesOperations();
  const { conversationId } = useOptionalMessagesConversation();

  const conversationResourceMap = useConversationUIResources(conversationId ?? undefined);

  const uiResource = conversationResourceMap.get(resourceId ?? '');

  if (!uiResource) {
    return (
      <span className="inline-flex items-center rounded bg-surface-tertiary px-2 py-1 text-xs font-medium text-text-secondary">
        {localize('com_ui_ui_resource_not_found', {
          0: resourceId ?? '',
        })}
      </span>
    );
  }

  if (!isSupportedUIResource(uiResource)) {
    return null;
  }

  try {
    return (
      <span className="mx-1 inline-block w-full align-middle">
        <UIResourceRenderer
          resource={uiResource}
          onUIAction={async (result) => handleUIAction(result, ask)}
          htmlProps={{
            autoResizeIframe: { width: true, height: true },
          }}
        />
      </span>
    );
  } catch (error) {
    console.error('Error rendering UI resource:', error);
    return (
      <span className="inline-flex items-center rounded bg-status-error-subtle px-2 py-1 text-xs font-medium text-status-error">
        {localize('com_ui_ui_resource_error', { 0: uiResource.name || resourceId })}
      </span>
    );
  }
}
