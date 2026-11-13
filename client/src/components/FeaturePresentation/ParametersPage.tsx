import { useLayoutEffect, useMemo, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { Spinner } from '@librechat/client';
import { Navigate, useLocation } from 'react-router-dom';
import { useUserKeyQuery, useGetEndpointModelsQuery } from 'librechat-data-provider/react-query';
import {
  getDefaultParamsEndpoint,
  isAgentsEndpoint,
  isParamEndpoint,
} from 'librechat-data-provider';
import { useGetStartupConfig, useGetEndpointsQuery } from '~/data-provider';
import { getChatReturnUrl, getPageSettings } from './registry';
import CollectionError from '~/components/ui/CollectionError';
import { useFeaturePresentation } from './Context';
import useLocalize from '~/hooks/useLocalize';
import { buildDefaultConvo } from '~/utils';
import ChatRoute from '~/routes/ChatRoute';
import FeaturePage from './Page';
import store from '~/store';

/** Parameters owns a conversation, even when its page is the first route visited. */
export default function ParametersPage() {
  const location = useLocation();
  const chatUrl = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const source = new URL(
      getChatReturnUrl(params.get('chat') ?? undefined),
      window.location.origin,
    );
    params.forEach((value, key) => {
      if (key !== 'chat') source.searchParams.set(key, value);
    });
    return source.pathname + source.search + source.hash;
  }, [location.search]);
  return <ParametersContext key={chatUrl} chatUrl={chatUrl} />;
}

function ParametersContext({ chatUrl }: { chatUrl: string }) {
  const presentation = useFeaturePresentation();
  const localize = useLocalize();
  const { data: config } = useGetStartupConfig();
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const { setConversation } = store.useSetConversationAtom(0);
  // Capture entry intent, not later CREATED/ACK identity changes.
  const [activation] = useState(() => {
    const pathname = new URL(chatUrl, window.location.origin).pathname;
    const target = decodeURIComponent(pathname.slice('/c/'.length));
    return {
      cold: conversation == null,
      redirect:
        conversation != null &&
        target !== 'new' &&
        target !== conversation.conversationId &&
        pathname !== presentation?.chatLocation?.pathname,
    };
  });
  const { data: endpoints } = useGetEndpointsQuery();
  const credentials = useUserKeyQuery(conversation?.endpoint ?? '');
  const awaitsCredentials =
    endpoints?.[conversation?.endpoint ?? '']?.userProvide === true && credentials.data == null;
  const initialize =
    presentation?.ready === true &&
    config?.interface?.parameters === true &&
    getPageSettings(config.interface.navigation, 'parameters').enabled;
  const endpoint = conversation?.endpoint ?? '';
  const discover =
    initialize &&
    activation.cold &&
    !activation.redirect &&
    endpoint !== '' &&
    !conversation?.model &&
    !isAgentsEndpoint(endpoint);
  const models = useGetEndpointModelsQuery(endpoint, { enabled: discover });
  const setReturnTarget = presentation?.setReturnTarget;
  useLayoutEffect(() => {
    if (initialize && activation.cold) setReturnTarget?.(chatUrl);
  }, [initialize, activation.cold, setReturnTarget, chatUrl]);
  const awaitsCredentialLinks =
    initialize &&
    endpoints?.[endpoint]?.userProvide === true &&
    !!credentials.data?.expiresAt &&
    isParamEndpoint(endpoint, conversation?.endpointType ?? '') &&
    !isAgentsEndpoint(endpoint) &&
    !presentation.canOpenPage('parameters');
  const needsModel =
    discover &&
    conversation?.conversationId === 'new' &&
    !conversation.model &&
    (models.data?.[endpoint]?.length ?? 0) > 0;
  useLayoutEffect(() => {
    if (!needsModel) return;
    setConversation((previous) => {
      if (
        !previous ||
        previous.endpoint !== endpoint ||
        previous.model ||
        previous.conversationId !== 'new'
      )
        return previous;
      return buildDefaultConvo({
        conversation: previous,
        lastConversationSetup: previous,
        endpoint: previous.endpoint,
        models: models.data?.[endpoint],
        defaultParamsEndpoint: getDefaultParamsEndpoint(endpoints, endpoint),
      });
    });
  }, [needsModel, setConversation, endpoint, models.data, endpoints]);
  if (initialize && activation.redirect) return <Navigate to={chatUrl} replace />;
  if (initialize && conversation == null) {
    return <ChatRoute initializeFrom={chatUrl} />;
  }
  if (discover && models.data == null && models.isError) {
    return <CollectionError onRetry={() => void models.refetch()} />;
  }
  if (
    initialize &&
    (awaitsCredentials || awaitsCredentialLinks || (discover && models.data == null) || needsModel)
  ) {
    if (awaitsCredentials && credentials.isError)
      return <CollectionError onRetry={() => void credentials.refetch()} />;
    return (
      <div
        role="status"
        aria-label={localize('com_ui_loading')}
        className="flex h-full items-center justify-center"
      >
        <Spinner />
      </div>
    );
  }
  return <FeaturePage page="parameters" />;
}
