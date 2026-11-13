import { useLayoutEffect, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { Spinner } from '@librechat/client';
import { useLocation } from 'react-router-dom';
import { useUserKeyQuery, useGetModelsQuery } from 'librechat-data-provider/react-query';
import { useGetStartupConfig, useGetEndpointsQuery } from '~/data-provider';
import { getChatReturnUrl, getPageSettings } from './registry';
import CollectionError from '~/components/ui/CollectionError';
import { useFeaturePresentation } from './Context';
import useLocalize from '~/hooks/useLocalize';
import ChatRoute from '~/routes/ChatRoute';
import FeaturePage from './Page';
import store from '~/store';

/** Parameters owns a conversation, even when its page is the first route visited. */
export default function ParametersPage() {
  const presentation = useFeaturePresentation();
  const localize = useLocalize();
  const { data: config } = useGetStartupConfig();
  const conversation = useRecoilValue(store.conversationByIndex(0));
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
  const { data: endpoints } = useGetEndpointsQuery();
  const credentials = useUserKeyQuery(conversation?.endpoint ?? '');
  const awaitsCredentials =
    endpoints?.[conversation?.endpoint ?? '']?.userProvide === true && credentials.data == null;
  const chatLocation = useMemo(() => {
    const target = new URL(chatUrl, window.location.origin);
    return { ...location, pathname: target.pathname, search: target.search, hash: target.hash };
  }, [chatUrl, location]);
  const initialize =
    presentation?.ready === true &&
    config?.interface?.parameters === true &&
    getPageSettings(config.interface.navigation, 'parameters').enabled;
  const models = useGetModelsQuery({ enabled: initialize && conversation == null });
  const updateLocation = presentation?.updateChatLocation;
  useLayoutEffect(() => {
    if (initialize) updateLocation?.(chatLocation);
  }, [initialize, updateLocation, chatLocation]);
  if (initialize && conversation == null) {
    if (models.isError && models.data == null)
      return <CollectionError onRetry={() => void models.refetch()} />;
    if (models.data != null)
      return <ChatRoute initializeFrom={chatUrl} initialModels={models.data} />;
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
  if (initialize && awaitsCredentials) {
    if (credentials.isError) return <CollectionError onRetry={() => void credentials.refetch()} />;
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
