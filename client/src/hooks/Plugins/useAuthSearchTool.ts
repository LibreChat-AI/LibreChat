import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUpdateUserPluginsMutation } from 'librechat-data-provider/react-query';
import {
  Tools,
  AuthType,
  QueryKeys,
  RerankerTypes,
  SearchProviders,
  ScraperProviders,
} from 'librechat-data-provider';

export type SearchApiKeyFormData = {
  // Selected options
  selectedProvider?: SearchProviders;
  selectedReranker?: RerankerTypes;
  selectedScraper?: ScraperProviders;
  // API keys and URLs
  serperApiKey: string;
  searxngInstanceUrl: string;
  searxngApiKey: string;
  firecrawlApiKey: string;
  firecrawlApiUrl: string;
  tavilyApiKey: string;
  keenableApiKey: string;
  keenableApiUrl: string;
  jinaApiKey: string;
  jinaApiUrl: string;
  cohereApiKey: string;
};

export type SearchApiKeyDirtyFields = Partial<Record<keyof SearchApiKeyFormData, boolean>>;

const useAuthSearchTool = (options?: { isEntityTool: boolean }) => {
  const queryClient = useQueryClient();
  const isEntityTool = options?.isEntityTool ?? true;
  /* `mutate` rather than the mutation object: react-query hands back a fresh
     result object on every render, and depending on it made both callbacks
     below new identities each time, which travelled up through
     `useSearchApiKeyForm` into `BadgeRowProvider`'s context value. */
  const { mutate: updateUserPlugins } = useUpdateUserPluginsMutation({
    onMutate: (vars) => {
      queryClient.setQueryData([QueryKeys.toolAuth, Tools.web_search], () => {
        return {
          authenticated: vars.action === 'install',
          searchProvider: vars.auth?.selectedProvider,
          scraperProvider: vars.auth?.selectedScraper,
          rerankerType: vars.auth?.selectedReranker,
          authTypes:
            vars.action === 'install'
              ? [
                  ['providers', AuthType.USER_PROVIDED],
                  ['scrapers', AuthType.USER_PROVIDED],
                  ['rerankers', AuthType.USER_PROVIDED],
                ]
              : [],
        };
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.toolAuth, Tools.web_search]);
    },
    onError: () => {
      queryClient.invalidateQueries([QueryKeys.toolAuth, Tools.web_search]);
    },
  });

  const installTool = useCallback(
    (data: SearchApiKeyFormData, dirtyFields: SearchApiKeyDirtyFields = {}) => {
      const auth = Object.entries({
        selectedProvider: data.selectedProvider,
        selectedScraper: data.selectedScraper,
        selectedReranker: data.selectedReranker,
        serperApiKey: data.serperApiKey,
        searxngInstanceUrl: data.searxngInstanceUrl,
        searxngApiKey: data.searxngApiKey,
        firecrawlApiKey: data.firecrawlApiKey,
        firecrawlApiUrl: data.firecrawlApiUrl,
        tavilyApiKey: data.tavilyApiKey,
        keenableApiKey: data.keenableApiKey,
        keenableApiUrl: data.keenableApiUrl,
        jinaApiKey: data.jinaApiKey,
        jinaApiUrl: data.jinaApiUrl,
        cohereApiKey: data.cohereApiKey,
      }).reduce(
        (acc, [key, value]) => {
          const wasExplicitlyCleared =
            value === '' && dirtyFields[key as keyof SearchApiKeyFormData] === true;
          if (value || wasExplicitlyCleared) {
            acc[key] = value;
          }
          return acc;
        },
        {} as Record<string, string>,
      );

      updateUserPlugins({
        pluginKey: Tools.web_search,
        action: 'install',
        auth,
        isEntityTool,
      });
    },
    [updateUserPlugins, isEntityTool],
  );

  const removeTool = useCallback(() => {
    updateUserPlugins({
      pluginKey: Tools.web_search,
      action: 'uninstall',
      auth: {},
      isEntityTool,
    });
  }, [updateUserPlugins, isEntityTool]);

  return {
    removeTool,
    installTool,
  };
};

export default useAuthSearchTool;
