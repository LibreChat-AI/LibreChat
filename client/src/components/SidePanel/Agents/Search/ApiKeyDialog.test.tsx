import React from 'react';
import { useForm } from 'react-hook-form';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  AuthType,
  RerankerTypes,
  SearchProviders,
  SearchCategories,
  ScraperProviders,
} from 'librechat-data-provider';
import type { SearchApiKeyFormData } from '~/hooks/Plugins/useAuthSearchTool';
import { clickDropdown, flushDropdownEffects } from 'test/dropdown';
import { useGetStartupConfig } from '~/data-provider';
import ApiKeyDialog from './ApiKeyDialog';

// Mock useLocalize to just return the key
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(),
}));

const mockRegister = (name: string) => ({
  onChange: jest.fn(),
  onBlur: jest.fn(),
  ref: jest.fn(),
  name,
});

const defaultProps = {
  isOpen: true,
  onOpenChange: jest.fn(),
  onSubmit: jest.fn(),
  onRevoke: jest.fn(),
  authTypes: [
    [SearchCategories.PROVIDERS, AuthType.USER_PROVIDED] as [string, AuthType],
    [SearchCategories.SCRAPERS, AuthType.USER_PROVIDED] as [string, AuthType],
    [SearchCategories.RERANKERS, AuthType.USER_PROVIDED] as [string, AuthType],
  ],
  isToolAuthenticated: false,
  register: mockRegister as any,
  setValue: jest.fn(),
  handleSubmit: (fn: any) => (e: any) => fn(e),
};

function FormDialog(props: Partial<React.ComponentProps<typeof ApiKeyDialog>>) {
  const methods = useForm<SearchApiKeyFormData>();
  return (
    <ApiKeyDialog
      {...defaultProps}
      {...props}
      register={methods.register}
      setValue={methods.setValue}
      handleSubmit={methods.handleSubmit}
    />
  );
}

describe('ApiKeyDialog', () => {
  const mockUseGetStartupConfig = useGetStartupConfig as jest.Mock;

  afterEach(() => jest.clearAllMocks());

  it('shows all dropdowns and both reranker fields when no config is set', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    render(<ApiKeyDialog {...defaultProps} />);
    // Provider dropdown button
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_provider_serper' }),
    ).toBeInTheDocument();
    // Scraper dropdown button
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_scraper_firecrawl' }),
    ).toBeInTheDocument();
    // Reranker dropdown button
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_reranker_jina' }),
    ).toBeInTheDocument();
    // Reranker fields (default is Jina)
    expect(screen.getByPlaceholderText('com_ui_web_search_jina_key')).toBeInTheDocument();
    // Switch to Cohere
    fireEvent.click(screen.getByText('com_ui_web_search_reranker_cohere'));
    expect(screen.getByPlaceholderText('com_ui_web_search_cohere_key')).toBeInTheDocument();
  });

  it('selects Kagi with a secret key input and leaves the scraper and reranker unchanged', async () => {
    const setValue = jest.fn();
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    render(<ApiKeyDialog {...defaultProps} setValue={setValue} />);
    await flushDropdownEffects();

    await clickDropdown(screen.getByRole('button', { name: 'com_ui_web_search_provider_serper' }));
    await clickDropdown(screen.getByRole('menuitem', { name: 'com_ui_web_search_provider_kagi' }));

    expect(setValue).toHaveBeenCalledWith('selectedProvider', SearchProviders.KAGI);
    expect(screen.getByPlaceholderText('com_ui_web_search_kagi_key')).toHaveAttribute(
      'type',
      'password',
    );
    expect(
      screen.getByRole('link', { name: 'com_ui_web_search_provider_kagi_key' }),
    ).toHaveAttribute('href', 'https://kagi.com/api/keys');
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_scraper_firecrawl' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_reranker_jina' }),
    ).toBeInTheDocument();

    await clickDropdown(
      screen.getByRole('button', { name: 'com_ui_web_search_scraper_firecrawl' }),
    );
    expect(
      screen.queryByRole('menuitem', { name: 'com_ui_web_search_provider_kagi' }),
    ).not.toBeInTheDocument();
  });

  it('submits the selected Kagi provider and key through the registered form', async () => {
    const onSubmit = jest.fn();
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    render(<FormDialog onSubmit={onSubmit} />);
    await flushDropdownEffects();

    await clickDropdown(screen.getByRole('button', { name: 'com_ui_web_search_provider_serper' }));
    await clickDropdown(screen.getByRole('menuitem', { name: 'com_ui_web_search_provider_kagi' }));
    fireEvent.change(screen.getByPlaceholderText('com_ui_web_search_kagi_key'), {
      target: { value: 'kagi-test-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedProvider: SearchProviders.KAGI,
          kagiApiKey: 'kagi-test-key',
          selectedScraper: ScraperProviders.FIRECRAWL,
          selectedReranker: RerankerTypes.JINA,
        }),
      ),
    );
  });

  it('restores a saved Kagi provider when the dialog is reopened', async () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    const { rerender } = render(
      <ApiKeyDialog {...defaultProps} searchProvider={SearchProviders.KAGI} />,
    );
    await flushDropdownEffects();
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_provider_kagi' }),
    ).toBeInTheDocument();

    await clickDropdown(screen.getByRole('button', { name: 'com_ui_web_search_provider_kagi' }));
    await clickDropdown(
      screen.getByRole('menuitem', { name: 'com_ui_web_search_provider_serper' }),
    );
    rerender(
      <ApiKeyDialog {...defaultProps} isOpen={false} searchProvider={SearchProviders.KAGI} />,
    );
    rerender(<ApiKeyDialog {...defaultProps} searchProvider={SearchProviders.KAGI} />);
    await flushDropdownEffects();

    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_provider_kagi' }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('com_ui_web_search_kagi_key')).toBeInTheDocument();
  });

  it('accepts a key for admin-pinned Kagi without submitting a provider override', async () => {
    const onSubmit = jest.fn();
    mockUseGetStartupConfig.mockReturnValue({
      data: { webSearch: { searchProvider: SearchProviders.KAGI } },
    });
    render(<FormDialog onSubmit={onSubmit} searchProvider={SearchProviders.SERPER} />);
    await flushDropdownEffects();

    expect(screen.getByText('com_ui_web_search_provider_kagi')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_web_search_provider_kagi' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('com_ui_web_search_kagi_key'), {
      target: { value: 'kagi-test-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual(
      expect.objectContaining({ kagiApiKey: 'kagi-test-key' }),
    );
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('selectedProvider');
  });

  it('hides system-defined Kagi credentials while retaining scraper and reranker setup', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: { webSearch: { searchProvider: SearchProviders.KAGI } },
    });
    render(
      <ApiKeyDialog
        {...defaultProps}
        authTypes={[
          [SearchCategories.PROVIDERS, AuthType.SYSTEM_DEFINED],
          [SearchCategories.SCRAPERS, AuthType.USER_PROVIDED],
          [SearchCategories.RERANKERS, AuthType.USER_PROVIDED],
        ]}
      />,
    );
    await flushDropdownEffects();

    expect(screen.queryByText('com_ui_web_search_provider')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('com_ui_web_search_kagi_key')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_web_search_scraper')).toBeInTheDocument();
    expect(screen.getByText('com_ui_web_search_reranker')).toBeInTheDocument();
  });

  it('selects Kagi Extract with a shared secret key and leaves search and reranking unchanged', async () => {
    const setValue = jest.fn();
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    render(<ApiKeyDialog {...defaultProps} setValue={setValue} />);
    await flushDropdownEffects();

    await clickDropdown(
      screen.getByRole('button', { name: 'com_ui_web_search_scraper_firecrawl' }),
    );
    await clickDropdown(screen.getByRole('menuitem', { name: 'com_ui_web_search_scraper_kagi' }));

    expect(setValue).toHaveBeenCalledWith('selectedScraper', ScraperProviders.KAGI);
    expect(screen.getByPlaceholderText('com_ui_web_search_kagi_key')).toHaveAttribute(
      'name',
      'kagiApiKey',
    );
    expect(screen.getByPlaceholderText('com_ui_web_search_kagi_key')).toHaveAttribute(
      'type',
      'password',
    );
    expect(
      screen.getByRole('link', { name: 'com_ui_web_search_scraper_kagi_key' }),
    ).toHaveAttribute('href', 'https://kagi.com/api/keys');
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_provider_serper' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_reranker_jina' }),
    ).toBeInTheDocument();
  });

  it.each([SearchProviders.SERPER, SearchProviders.KAGI])(
    'submits Kagi Extract and its shared key with search provider %s',
    async (searchProvider) => {
      const onSubmit = jest.fn();
      mockUseGetStartupConfig.mockReturnValue({ data: {} });
      render(<FormDialog onSubmit={onSubmit} searchProvider={searchProvider} />);
      await flushDropdownEffects();

      await clickDropdown(
        screen.getByRole('button', { name: 'com_ui_web_search_scraper_firecrawl' }),
      );
      await clickDropdown(screen.getByRole('menuitem', { name: 'com_ui_web_search_scraper_kagi' }));
      const keyInputs = screen.getAllByPlaceholderText('com_ui_web_search_kagi_key');
      expect(keyInputs).toHaveLength(1);
      expect(keyInputs[0]).toHaveAttribute('name', 'kagiApiKey');
      fireEvent.change(keyInputs[0], {
        target: { value: 'shared-kagi-test-key' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            selectedProvider: searchProvider,
            selectedScraper: 'kagi',
            kagiApiKey: 'shared-kagi-test-key',
            selectedReranker: RerankerTypes.JINA,
          }),
        ),
      );
    },
  );

  it('restores a saved Kagi Extract scraper when the dialog is reopened', async () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    const props = { ...defaultProps, scraperProvider: ScraperProviders.KAGI };
    const { rerender } = render(<ApiKeyDialog {...props} />);
    await flushDropdownEffects();
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_scraper_kagi' }),
    ).toBeInTheDocument();

    await clickDropdown(screen.getByRole('button', { name: 'com_ui_web_search_scraper_kagi' }));
    await clickDropdown(
      screen.getByRole('menuitem', { name: 'com_ui_web_search_scraper_firecrawl' }),
    );
    rerender(<ApiKeyDialog {...props} isOpen={false} />);
    rerender(<ApiKeyDialog {...props} />);
    await flushDropdownEffects();

    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_scraper_kagi' }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('com_ui_web_search_kagi_key')).toBeInTheDocument();
  });

  it('accepts a key for admin-pinned Kagi Extract without submitting a scraper override', async () => {
    const onSubmit = jest.fn();
    mockUseGetStartupConfig.mockReturnValue({
      data: { webSearch: { scraperProvider: ScraperProviders.KAGI } },
    });
    render(<FormDialog onSubmit={onSubmit} scraperProvider={ScraperProviders.FIRECRAWL} />);
    await flushDropdownEffects();

    expect(screen.getByText('com_ui_web_search_scraper_kagi')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'com_ui_web_search_scraper_kagi' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('com_ui_web_search_kagi_key'), {
      target: { value: 'shared-kagi-test-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual(
      expect.objectContaining({ kagiApiKey: 'shared-kagi-test-key' }),
    );
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('selectedScraper');
  });

  it.each([AuthType.USER_PROVIDED, AuthType.SYSTEM_DEFINED])(
    'submits one shared key for admin-pinned Kagi search and Extract with provider auth %s',
    async (providerAuthType) => {
      const onSubmit = jest.fn();
      mockUseGetStartupConfig.mockReturnValue({
        data: {
          webSearch: {
            searchProvider: SearchProviders.KAGI,
            scraperProvider: ScraperProviders.KAGI,
            rerankerType: RerankerTypes.NONE,
          },
        },
      });
      render(
        <FormDialog
          onSubmit={onSubmit}
          authTypes={[
            [SearchCategories.PROVIDERS, providerAuthType],
            [SearchCategories.SCRAPERS, AuthType.USER_PROVIDED],
            [SearchCategories.RERANKERS, AuthType.USER_PROVIDED],
          ]}
        />,
      );
      await flushDropdownEffects();

      const keyInputs = screen.getAllByPlaceholderText('com_ui_web_search_kagi_key');
      expect(keyInputs).toHaveLength(1);
      const keyLink =
        providerAuthType === AuthType.SYSTEM_DEFINED
          ? 'com_ui_web_search_scraper_kagi_key'
          : 'com_ui_web_search_provider_kagi_key';
      expect(screen.getByRole('link', { name: keyLink })).toBeInTheDocument();
      fireEvent.change(keyInputs[0], { target: { value: 'shared-kagi-test-key' } });
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith({ kagiApiKey: 'shared-kagi-test-key' }),
      );
    },
  );

  it.each([
    {
      searchProvider: SearchProviders.SERPER,
      scraperProvider: ScraperProviders.SERPER,
      key: 'serperApiKey',
    },
    {
      searchProvider: SearchProviders.TAVILY,
      scraperProvider: ScraperProviders.TAVILY,
      key: 'tavilyApiKey',
    },
  ])(
    'deduplicates and submits the shared $key input',
    async ({ searchProvider, scraperProvider, key }) => {
      const onSubmit = jest.fn();
      mockUseGetStartupConfig.mockReturnValue({
        data: { webSearch: { searchProvider, scraperProvider, rerankerType: RerankerTypes.NONE } },
      });
      render(<FormDialog onSubmit={onSubmit} />);
      await flushDropdownEffects();

      const keyInputs = screen.getAllByPlaceholderText('com_ui_enter_api_key');
      expect(keyInputs).toHaveLength(1);
      expect(keyInputs[0]).toHaveAttribute('name', key);
      fireEvent.change(keyInputs[0], { target: { value: 'shared-test-key' } });
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ [key]: 'shared-test-key' }));
    },
  );

  it('preserves the shared Kagi key when changing search moves the input to the scraper', async () => {
    const onSubmit = jest.fn();
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    render(
      <FormDialog
        onSubmit={onSubmit}
        searchProvider={SearchProviders.KAGI}
        scraperProvider={ScraperProviders.KAGI}
      />,
    );
    await flushDropdownEffects();

    expect(screen.getAllByPlaceholderText('com_ui_web_search_kagi_key')).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText('com_ui_web_search_kagi_key'), {
      target: { value: 'shared-kagi-test-key' },
    });
    await clickDropdown(screen.getByRole('button', { name: 'com_ui_web_search_provider_kagi' }));
    await clickDropdown(
      screen.getByRole('menuitem', { name: 'com_ui_web_search_provider_serper' }),
    );

    expect(screen.getAllByPlaceholderText('com_ui_web_search_kagi_key')).toHaveLength(1);
    expect(screen.getByPlaceholderText('com_ui_web_search_kagi_key')).toHaveValue(
      'shared-kagi-test-key',
    );
    expect(
      screen.getByRole('link', { name: 'com_ui_web_search_scraper_kagi_key' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedProvider: SearchProviders.SERPER,
          selectedScraper: ScraperProviders.KAGI,
          kagiApiKey: 'shared-kagi-test-key',
        }),
      ),
    );
  });

  it('hides system-defined Kagi Extract credentials without hiding other categories', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: { webSearch: { scraperProvider: ScraperProviders.KAGI } },
    });
    render(
      <ApiKeyDialog
        {...defaultProps}
        authTypes={[
          [SearchCategories.PROVIDERS, AuthType.USER_PROVIDED],
          [SearchCategories.SCRAPERS, AuthType.SYSTEM_DEFINED],
          [SearchCategories.RERANKERS, AuthType.USER_PROVIDED],
        ]}
      />,
    );
    await flushDropdownEffects();

    expect(screen.queryByText('com_ui_web_search_scraper')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('com_ui_web_search_kagi_key')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_web_search_provider')).toBeInTheDocument();
    expect(screen.getByText('com_ui_web_search_reranker')).toBeInTheDocument();
  });

  it('restores per-user provider and scraper selections', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    render(
      <ApiKeyDialog
        {...defaultProps}
        searchProvider={SearchProviders.KEENABLE}
        scraperProvider={ScraperProviders.KEENABLE}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_provider_keenable' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_scraper_keenable' }),
    ).toBeInTheDocument();
  });

  it('writes keyless provider and reranker selections into the submitted form', () => {
    const setValue = jest.fn();
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    render(<ApiKeyDialog {...defaultProps} setValue={setValue} />);

    fireEvent.click(screen.getByText('com_ui_web_search_provider_keenable'));
    fireEvent.click(screen.getByText('com_ui_web_search_reranker_none'));

    expect(setValue).toHaveBeenCalledWith('selectedProvider', SearchProviders.KEENABLE);
    expect(setValue).toHaveBeenCalledWith('selectedReranker', RerankerTypes.NONE);
    expect(screen.getByPlaceholderText('com_ui_web_search_keenable_url')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('com_ui_web_search_jina_key')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('com_ui_web_search_cohere_key')).not.toBeInTheDocument();
  });

  it('shows static text for provider and only provider input if provider is set', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: { webSearch: { searchProvider: 'serper' } } });
    render(<ApiKeyDialog {...defaultProps} />);
    expect(screen.getByText('com_ui_web_search_provider_serper')).toBeInTheDocument();
    // Should not find a dropdown button for provider
    expect(screen.queryByRole('button', { name: /provider/i })).not.toBeInTheDocument();
  });

  it('shows the custom URL input when Keenable is pinned but user-configurable', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: { webSearch: { searchProvider: SearchProviders.KEENABLE } },
    });
    render(<ApiKeyDialog {...defaultProps} />);

    expect(screen.getByPlaceholderText('com_ui_web_search_keenable_url')).toBeInTheDocument();
  });

  it('shows only Jina reranker field if rerankerType is set to jina', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: { webSearch: { rerankerType: RerankerTypes.JINA } },
    });
    render(<ApiKeyDialog {...defaultProps} />);
    expect(screen.getByPlaceholderText('com_ui_web_search_jina_key')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('com_ui_web_search_cohere_key')).not.toBeInTheDocument();
  });

  it('shows only Cohere reranker field if rerankerType is set to cohere', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: { webSearch: { rerankerType: RerankerTypes.COHERE } },
    });
    render(<ApiKeyDialog {...defaultProps} />);
    expect(screen.getByPlaceholderText('com_ui_web_search_cohere_key')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('com_ui_web_search_jina_key')).not.toBeInTheDocument();
  });

  it('shows documentation link for the visible reranker', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    render(<ApiKeyDialog {...defaultProps} />);
    // Default is Jina
    expect(screen.getByRole('link', { name: 'com_ui_web_search_reranker_jina_key' })).toHaveClass(
      'text-link',
      'underline',
      'hover:text-link-hover',
    );
    // Switch to Cohere
    fireEvent.click(screen.getByText('com_ui_web_search_reranker_cohere'));
    expect(screen.getByRole('link', { name: 'com_ui_web_search_reranker_cohere_key' })).toHaveClass(
      'text-link',
      'underline',
      'hover:text-link-hover',
    );
  });

  it('does not render provider section if SYSTEM_DEFINED', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    const props = {
      ...defaultProps,
      authTypes: [
        [SearchCategories.PROVIDERS, AuthType.SYSTEM_DEFINED],
        [SearchCategories.SCRAPERS, AuthType.USER_PROVIDED],
        [SearchCategories.RERANKERS, AuthType.USER_PROVIDED],
      ] as [string, AuthType][],
    };
    render(<ApiKeyDialog {...props} />);
    expect(screen.queryByText('com_ui_web_search_provider')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_web_search_scraper')).toBeInTheDocument();
    expect(screen.getByText('com_ui_web_search_reranker')).toBeInTheDocument();
  });

  it('does not submit selections for system-defined categories', () => {
    const onSubmit = jest.fn();
    const formData = {
      selectedProvider: SearchProviders.SERPER,
      selectedScraper: ScraperProviders.KEENABLE,
      selectedReranker: RerankerTypes.NONE,
      keenableApiKey: '',
    } as any;
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    render(
      <ApiKeyDialog
        {...defaultProps}
        onSubmit={onSubmit}
        authTypes={[
          [SearchCategories.PROVIDERS, AuthType.SYSTEM_DEFINED],
          [SearchCategories.SCRAPERS, AuthType.USER_PROVIDED],
          [SearchCategories.RERANKERS, AuthType.SYSTEM_DEFINED],
        ]}
        handleSubmit={(fn: any) => () => fn(formData)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    expect(onSubmit).toHaveBeenCalledWith({
      selectedScraper: ScraperProviders.KEENABLE,
      keenableApiKey: '',
    });
  });

  it('does not submit selections for admin-pinned user-auth categories', () => {
    const onSubmit = jest.fn();
    const formData = {
      selectedProvider: SearchProviders.KEENABLE,
      selectedScraper: ScraperProviders.KEENABLE,
      selectedReranker: RerankerTypes.NONE,
      keenableApiKey: 'user-key',
    } as any;
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        webSearch: {
          searchProvider: SearchProviders.KEENABLE,
          scraperProvider: ScraperProviders.KEENABLE,
          rerankerType: RerankerTypes.NONE,
        },
      },
    });
    render(
      <ApiKeyDialog
        {...defaultProps}
        onSubmit={onSubmit}
        handleSubmit={(fn: any) => () => fn(formData)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    expect(onSubmit).toHaveBeenCalledWith({ keenableApiKey: 'user-key' });
  });

  it('does not render scraper section if SYSTEM_DEFINED', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    const props = {
      ...defaultProps,
      authTypes: [
        [SearchCategories.PROVIDERS, AuthType.USER_PROVIDED],
        [SearchCategories.SCRAPERS, AuthType.SYSTEM_DEFINED],
        [SearchCategories.RERANKERS, AuthType.USER_PROVIDED],
      ] as [string, AuthType][],
    };
    render(<ApiKeyDialog {...props} />);
    expect(screen.getByText('com_ui_web_search_provider')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_web_search_scraper')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_web_search_reranker')).toBeInTheDocument();
  });

  it('does not render reranker section if SYSTEM_DEFINED', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    const props = {
      ...defaultProps,
      authTypes: [
        [SearchCategories.PROVIDERS, AuthType.USER_PROVIDED],
        [SearchCategories.SCRAPERS, AuthType.USER_PROVIDED],
        [SearchCategories.RERANKERS, AuthType.SYSTEM_DEFINED],
      ] as [string, AuthType][],
    };
    render(<ApiKeyDialog {...props} />);
    expect(screen.getByText('com_ui_web_search_provider')).toBeInTheDocument();
    expect(screen.getByText('com_ui_web_search_scraper')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_web_search_reranker')).not.toBeInTheDocument();
  });
});
