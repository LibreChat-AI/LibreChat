import { useEffect, useState } from 'react';
import { Button, OGDialog, OGDialogTemplate } from '@librechat/client';
import {
  AuthType,
  RerankerTypes,
  SearchProviders,
  ScraperProviders,
  SearchCategories,
} from 'librechat-data-provider';
import type { UseFormRegister, UseFormHandleSubmit, UseFormSetValue } from 'react-hook-form';
import type { SearchApiKeyFormData } from '~/hooks/Plugins/useAuthSearchTool';
import InputSection, { type DropdownOption } from './InputSection';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function ApiKeyDialog({
  isOpen,
  onSubmit,
  onRevoke,
  onOpenChange,
  authTypes,
  isToolAuthenticated,
  register,
  setValue,
  handleSubmit,
  triggerRef,
  triggerRefs,
  searchProvider,
  scraperProvider,
  rerankerType,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: SearchApiKeyFormData) => void;
  onRevoke: () => void;
  authTypes: [string, AuthType][];
  isToolAuthenticated: boolean;
  register: UseFormRegister<SearchApiKeyFormData>;
  setValue: UseFormSetValue<SearchApiKeyFormData>;
  handleSubmit: UseFormHandleSubmit<SearchApiKeyFormData>;
  triggerRef?: React.RefObject<HTMLInputElement | HTMLButtonElement>;
  triggerRefs?: React.RefObject<HTMLInputElement | HTMLButtonElement>[];
  searchProvider?: SearchProviders;
  scraperProvider?: ScraperProviders;
  rerankerType?: RerankerTypes;
}) {
  const localize = useLocalize();
  const { data: config } = useGetStartupConfig();

  const [selectedProvider, setSelectedProvider] = useState(
    config?.webSearch?.searchProvider || searchProvider || SearchProviders.SERPER,
  );
  const [selectedReranker, setSelectedReranker] = useState(
    config?.webSearch?.rerankerType || rerankerType || RerankerTypes.JINA,
  );
  const [selectedScraper, setSelectedScraper] = useState(
    config?.webSearch?.scraperProvider || scraperProvider || ScraperProviders.FIRECRAWL,
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setSelectedProvider(
      config?.webSearch?.searchProvider || searchProvider || SearchProviders.SERPER,
    );
    setSelectedScraper(
      config?.webSearch?.scraperProvider || scraperProvider || ScraperProviders.FIRECRAWL,
    );
    setSelectedReranker(config?.webSearch?.rerankerType || rerankerType || RerankerTypes.JINA);
  }, [
    config?.webSearch?.rerankerType,
    config?.webSearch?.scraperProvider,
    config?.webSearch?.searchProvider,
    isOpen,
    rerankerType,
    scraperProvider,
    searchProvider,
  ]);

  useEffect(() => {
    setValue('selectedProvider', selectedProvider);
    setValue('selectedScraper', selectedScraper);
    setValue('selectedReranker', selectedReranker);
  }, [selectedProvider, selectedReranker, selectedScraper, setValue]);

  const providerOptions: DropdownOption[] = [
    {
      key: SearchProviders.SERPER,
      label: localize('com_ui_web_search_provider_serper'),
      inputs: {
        serperApiKey: {
          placeholder: localize('com_ui_enter_api_key'),
          type: 'password' as const,
          link: {
            url: 'https://serper.dev/api-keys',
            text: localize('com_ui_web_search_provider_serper_key'),
          },
        },
      },
    },
    {
      key: SearchProviders.SEARXNG,
      label: localize('com_ui_web_search_provider_searxng'),
      inputs: {
        searxngInstanceUrl: {
          placeholder: localize('com_ui_web_search_searxng_instance_url'),
          type: 'text' as const,
        },
        searxngApiKey: {
          placeholder: localize('com_ui_web_search_searxng_api_key'),
          type: 'password' as const,
        },
      },
    },
    {
      key: SearchProviders.TAVILY,
      label: localize('com_ui_web_search_provider_tavily'),
      inputs: {
        tavilyApiKey: {
          placeholder: localize('com_ui_enter_api_key'),
          type: 'password' as const,
          link: {
            url: 'https://app.tavily.com/home',
            text: localize('com_ui_web_search_provider_tavily_key'),
          },
        },
      },
    },
    {
      key: SearchProviders.KEENABLE,
      label: localize('com_ui_web_search_provider_keenable'),
      inputs: {
        keenableApiKey: {
          placeholder: localize('com_ui_enter_api_key_optional'),
          type: 'password' as const,
          link: {
            url: 'https://keenable.ai',
            text: localize('com_ui_web_search_provider_keenable_key'),
          },
        },
        keenableApiUrl: {
          placeholder: localize('com_ui_web_search_keenable_url'),
          type: 'text' as const,
        },
      },
    },
  ];

  const rerankerOptions: DropdownOption[] = [
    {
      key: RerankerTypes.NONE,
      label: localize('com_ui_web_search_reranker_none'),
    },
    {
      key: RerankerTypes.JINA,
      label: localize('com_ui_web_search_reranker_jina'),
      inputs: {
        jinaApiKey: {
          placeholder: localize('com_ui_web_search_jina_key'),
          type: 'password' as const,
          link: {
            url: 'https://jina.ai/api-dashboard/',
            text: localize('com_ui_web_search_reranker_jina_key'),
          },
        },
        jinaApiUrl: {
          placeholder: localize('com_ui_web_search_jina_url'),
          type: 'text' as const,
          link: {
            url: 'https://api.jina.ai/v1/rerank',
            text: localize('com_ui_web_search_reranker_jina_url_help'),
          },
        },
      },
    },
    {
      key: RerankerTypes.COHERE,
      label: localize('com_ui_web_search_reranker_cohere'),
      inputs: {
        cohereApiKey: {
          placeholder: localize('com_ui_web_search_cohere_key'),
          type: 'password' as const,
          link: {
            url: 'https://dashboard.cohere.com/welcome/login',
            text: localize('com_ui_web_search_reranker_cohere_key'),
          },
        },
      },
    },
  ];

  const scraperOptions: DropdownOption[] = [
    {
      key: ScraperProviders.FIRECRAWL,
      label: localize('com_ui_web_search_scraper_firecrawl'),
      inputs: {
        firecrawlApiUrl: {
          placeholder: localize('com_ui_web_search_firecrawl_url'),
          type: 'text' as const,
        },
        firecrawlApiKey: {
          placeholder: localize('com_ui_enter_api_key'),
          type: 'password' as const,
          link: {
            url: 'https://docs.firecrawl.dev/introduction#api-key',
            text: localize('com_ui_web_search_scraper_firecrawl_key'),
          },
        },
      },
    },
    {
      key: ScraperProviders.SERPER,
      label: localize('com_ui_web_search_scraper_serper'),
      inputs: {
        serperApiKey: {
          placeholder: localize('com_ui_enter_api_key'),
          type: 'password' as const,
          link: {
            url: 'https://serper.dev/api-keys',
            text: localize('com_ui_web_search_scraper_serper_key'),
          },
        },
      },
    },
    {
      key: ScraperProviders.TAVILY,
      label: localize('com_ui_web_search_scraper_tavily'),
      inputs: {
        tavilyApiKey: {
          placeholder: localize('com_ui_enter_api_key'),
          type: 'password' as const,
          link: {
            url: 'https://app.tavily.com/home',
            text: localize('com_ui_web_search_scraper_tavily_key'),
          },
        },
      },
    },
    {
      key: ScraperProviders.KEENABLE,
      label: localize('com_ui_web_search_scraper_keenable'),
      inputs: {
        keenableApiKey: {
          placeholder: localize('com_ui_enter_api_key_optional'),
          type: 'password' as const,
          link: {
            url: 'https://keenable.ai',
            text: localize('com_ui_web_search_provider_keenable_key'),
          },
        },
      },
    },
  ];

  const [dropdownOpen, setDropdownOpen] = useState({
    provider: false,
    reranker: false,
    scraper: false,
  });

  const providerAuthType = authTypes.find(([cat]) => cat === SearchCategories.PROVIDERS)?.[1];
  const scraperAuthType = authTypes.find(([cat]) => cat === SearchCategories.SCRAPERS)?.[1];
  const rerankerAuthType = authTypes.find(([cat]) => cat === SearchCategories.RERANKERS)?.[1];

  const handleProviderChange = (key: string) => {
    setSelectedProvider(key as SearchProviders);
  };

  const handleRerankerChange = (key: string) => {
    setSelectedReranker(key as RerankerTypes);
  };

  const handleScraperChange = (key: string) => {
    setSelectedScraper(key as ScraperProviders);
  };

  const handleVisibleSubmit = (data: SearchApiKeyFormData) => {
    const visibleData = { ...data };
    if (providerAuthType === AuthType.SYSTEM_DEFINED || config?.webSearch?.searchProvider != null) {
      delete visibleData.selectedProvider;
    }
    if (scraperAuthType === AuthType.SYSTEM_DEFINED || config?.webSearch?.scraperProvider != null) {
      delete visibleData.selectedScraper;
    }
    if (rerankerAuthType === AuthType.SYSTEM_DEFINED || config?.webSearch?.rerankerType != null) {
      delete visibleData.selectedReranker;
    }
    onSubmit(visibleData);
  };

  return (
    <OGDialog
      open={isOpen}
      onOpenChange={onOpenChange}
      triggerRef={triggerRef}
      triggerRefs={triggerRefs}
    >
      <OGDialogTemplate
        className="w-11/12 sm:w-[500px]"
        title=""
        main={
          <>
            <div className="mb-4 text-center font-medium">{localize('com_ui_web_search')}</div>
            <form onSubmit={handleSubmit(handleVisibleSubmit)}>
              {/* Provider Section */}
              {providerAuthType !== AuthType.SYSTEM_DEFINED && (
                <InputSection
                  title={localize('com_ui_web_search_provider')}
                  selectedKey={selectedProvider}
                  onSelectionChange={handleProviderChange}
                  dropdownOptions={providerOptions}
                  showDropdown={!config?.webSearch?.searchProvider}
                  register={register}
                  dropdownOpen={dropdownOpen.provider}
                  setDropdownOpen={(open) =>
                    setDropdownOpen((prev) => ({ ...prev, provider: open }))
                  }
                  dropdownKey="provider"
                />
              )}

              {/* Scraper Section */}
              {scraperAuthType !== AuthType.SYSTEM_DEFINED && (
                <InputSection
                  title={localize('com_ui_web_search_scraper')}
                  selectedKey={selectedScraper}
                  onSelectionChange={handleScraperChange}
                  dropdownOptions={scraperOptions}
                  showDropdown={!config?.webSearch?.scraperProvider}
                  register={register}
                  dropdownOpen={dropdownOpen.scraper}
                  setDropdownOpen={(open) =>
                    setDropdownOpen((prev) => ({ ...prev, scraper: open }))
                  }
                  dropdownKey="scraper"
                />
              )}

              {/* Reranker Section */}
              {rerankerAuthType !== AuthType.SYSTEM_DEFINED && (
                <InputSection
                  title={localize('com_ui_web_search_reranker')}
                  selectedKey={selectedReranker}
                  onSelectionChange={handleRerankerChange}
                  dropdownOptions={rerankerOptions}
                  showDropdown={!config?.webSearch?.rerankerType}
                  register={register}
                  dropdownOpen={dropdownOpen.reranker}
                  setDropdownOpen={(open) =>
                    setDropdownOpen((prev) => ({ ...prev, reranker: open }))
                  }
                  dropdownKey="reranker"
                />
              )}
            </form>
          </>
        }
        selection={{
          selectHandler: handleSubmit(handleVisibleSubmit),
          selectClasses: 'bg-surface-submit hover:bg-surface-submit-hover text-text-on-status',
          selectText: localize('com_ui_save'),
        }}
        buttons={
          isToolAuthenticated && (
            <Button variant="destructive" onClick={onRevoke} aria-label={localize('com_ui_revoke')}>
              {localize('com_ui_revoke')}
            </Button>
          )
        }
        showCancelButton={true}
      />
    </OGDialog>
  );
}
