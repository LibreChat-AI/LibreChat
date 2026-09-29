import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  AuthType,
  RerankerTypes,
  SearchProviders,
  SearchCategories,
  ScraperProviders,
} from 'librechat-data-provider';
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
