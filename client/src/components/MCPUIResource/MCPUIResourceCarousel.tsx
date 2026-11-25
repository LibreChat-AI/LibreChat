import React, { useMemo } from 'react';
import type { UIResource } from 'librechat-data-provider';
import { useConversationUIResources } from '~/hooks/Messages/useConversationUIResources';
import UIResourceCarousel from '../Chat/Messages/Content/UIResourceCarousel';
import { useOptionalMessagesConversation } from '~/Providers';

interface MCPUIResourceCarouselProps {
  node: {
    properties: {
      resourceIds?: string[];
    };
  };
}

export function MCPUIResourceCarousel(props: MCPUIResourceCarouselProps) {
  const { conversationId } = useOptionalMessagesConversation();

  const conversationResourceMap = useConversationUIResources(conversationId ?? undefined);

  const uiResources = useMemo(() => {
    const { resourceIds = [] } = props.node.properties;

    return resourceIds.map((id) => conversationResourceMap.get(id)).filter(Boolean) as UIResource[];
  }, [props.node.properties, conversationResourceMap]);

  if (uiResources.length === 0) {
    return null;
  }

  return <UIResourceCarousel uiResources={uiResources} />;
}
