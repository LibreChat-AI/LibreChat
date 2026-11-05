import { memo, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TMessage, TNearAIAttestationParams } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider/Endpoints/queries';
import { getReceipts, replyEnvironment } from './reports';
import { prefetchReport } from './queries';

function Prefetch({
  messages,
  isSubmitting,
}: {
  messages?: TMessage[] | null;
  isSubmitting: boolean;
}) {
  const client = useQueryClient();
  const { data: config } = useGetStartupConfig();
  const warmedConversation = useRef<{ id?: string | null } | null>(null);
  useEffect(() => {
    if (!messages?.length || !config?.nearaiEndpoints?.length) return;
    const id = messages[0].conversationId;
    // Warm restored history once even during generation, then skip per-token scans.
    if (isSubmitting && warmedConversation.current && warmedConversation.current.id === id) return;
    warmedConversation.current = { id };
    const combinations = new Map<
      string,
      Pick<TNearAIAttestationParams, 'endpoint' | 'model' | 'scope'>
    >();
    for (const message of messages) {
      if (!message.metadata?.nearai) continue;
      for (const receipt of getReceipts(message)) {
        const params = replyEnvironment(message.endpoint, receipt);
        if (params && config?.nearaiEndpoints?.includes(params.endpoint)) {
          combinations.set(JSON.stringify([params.endpoint, params.model, params.scope]), params);
        }
      }
    }
    for (const params of combinations.values()) {
      void prefetchReport(client, params);
    }
  }, [client, messages, isSubmitting, config?.nearaiEndpoints]);
  return null;
}

export default memo(Prefetch);
