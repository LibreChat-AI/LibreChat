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
import { useGetStartupConfig } from '~/data-provider';
import ApiKeyDialog from './ApiKeyDialog';

const mockLocalize = jest.fn((key: string) => key);
const triggerLabel = 'Open search keys';

jest.mock('~/hooks', () => ({
  useLocalize: () => mockLocalize,
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

function DialogHarness({
  triggerMode = 'triggerRef',
  ...props
}: Partial<React.ComponentProps<typeof ApiKeyDialog>> & {
  triggerMode?: 'triggerRef' | 'triggerRefs';
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const { register, setValue, handleSubmit } = useForm<SearchApiKeyFormData>();

  return (
    <>
      <button ref={triggerRef} onClick={() => setIsOpen(true)}>
        {triggerLabel}
      </button>
      <ApiKeyDialog
        {...defaultProps}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        register={register}
        setValue={setValue}
        handleSubmit={handleSubmit}
        {...(triggerMode === 'triggerRef' ? { triggerRef } : { triggerRefs: [triggerRef] })}
        {...props}
      />
    </>
  );
}

describe('ApiKeyDialog', () => {
  const mockUseGetStartupConfig = useGetStartupConfig as jest.Mock;

  afterEach(() => jest.clearAllMocks());

  it('does not initialize the config subscription, options, or form before first opening', () => {
    const register = jest.fn(() => {
      throw new Error('Unexpected field registration before first opening');
    });
    const handleSubmit = jest.fn(defaultProps.handleSubmit);
    const props = { ...defaultProps, isOpen: false, register, handleSubmit };
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    const { container, rerender } = render(<ApiKeyDialog {...props} />);

    rerender(<ApiKeyDialog {...props} searchProvider={SearchProviders.KEENABLE} />);

    expect(container).toBeEmptyDOMElement();
    expect(mockUseGetStartupConfig).not.toHaveBeenCalled();
    expect(mockLocalize).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(defaultProps.setValue).not.toHaveBeenCalled();
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it('uses current provider props on first opening without writing stale defaults', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    const { rerender } = render(<ApiKeyDialog {...defaultProps} isOpen={false} />);
    const providers = {
      searchProvider: SearchProviders.KEENABLE,
      scraperProvider: ScraperProviders.TAVILY,
      rerankerType: RerankerTypes.COHERE,
    };
    rerender(<ApiKeyDialog {...defaultProps} {...providers} isOpen={false} />);
    rerender(<ApiKeyDialog {...defaultProps} {...providers} />);

    expect(defaultProps.setValue.mock.calls).toEqual([
      ['selectedProvider', SearchProviders.KEENABLE],
      ['selectedScraper', ScraperProviders.TAVILY],
      ['selectedReranker', RerankerTypes.COHERE],
    ]);
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_provider_keenable' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_scraper_tavily' }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('com_ui_web_search_cohere_key')).toBeInTheDocument();
  });

  it('uses current pinned config over provider props on first opening', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: { webSearch: { searchProvider: SearchProviders.SERPER } },
    });
    const props = { ...defaultProps, searchProvider: SearchProviders.SERPER };
    const { rerender } = render(<ApiKeyDialog {...props} isOpen={false} />);
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        webSearch: {
          searchProvider: SearchProviders.KEENABLE,
          scraperProvider: ScraperProviders.TAVILY,
          rerankerType: RerankerTypes.NONE,
        },
      },
    });

    rerender(<ApiKeyDialog {...props} />);

    expect(defaultProps.setValue.mock.calls).toEqual([
      ['selectedProvider', SearchProviders.KEENABLE],
      ['selectedScraper', ScraperProviders.TAVILY],
      ['selectedReranker', RerankerTypes.NONE],
    ]);
    expect(screen.getByText('com_ui_web_search_provider_keenable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /provider_keenable/ })).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_web_search_scraper_tavily')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('com_ui_web_search_jina_key')).not.toBeInTheDocument();
  });

  it('keeps the initialized content mounted while closed', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    const { rerender } = render(<ApiKeyDialog {...defaultProps} />);
    mockUseGetStartupConfig.mockClear();
    const setValue = jest.fn();

    rerender(<ApiKeyDialog {...defaultProps} isOpen={false} setValue={setValue} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockUseGetStartupConfig).toHaveBeenCalled();
    expect(setValue.mock.calls).toEqual([
      ['selectedProvider', SearchProviders.SERPER],
      ['selectedScraper', ScraperProviders.FIRECRAWL],
      ['selectedReranker', RerankerTypes.JINA],
    ]);
  });

  it('preserves entered secrets and URLs while resetting provider selections on reopen', async () => {
    const onSubmit = jest.fn();
    mockUseGetStartupConfig.mockReturnValue({ data: {} });
    render(<DialogHarness onSubmit={onSubmit} />);
    const trigger = screen.getByRole('button', { name: triggerLabel });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByText('com_ui_web_search_provider_keenable'));
    fireEvent.click(screen.getByText('com_ui_web_search_reranker_cohere'));
    fireEvent.change(screen.getByPlaceholderText('com_ui_web_search_keenable_url'), {
      target: { value: 'https://search.example.test' },
    });
    fireEvent.change(screen.getByPlaceholderText('com_ui_enter_api_key_optional'), {
      target: { value: 'retained-provider-secret' },
    });
    fireEvent.change(screen.getByPlaceholderText('com_ui_web_search_cohere_key'), {
      target: { value: 'retained-reranker-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);

    expect(
      screen.getByRole('button', { name: 'com_ui_web_search_provider_serper' }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('com_ui_web_search_jina_key')).toBeInTheDocument();
    fireEvent.click(screen.getByText('com_ui_web_search_provider_keenable'));
    fireEvent.click(screen.getByText('com_ui_web_search_reranker_cohere'));
    expect(screen.getByPlaceholderText('com_ui_web_search_keenable_url')).toHaveValue(
      'https://search.example.test',
    );
    expect(screen.getByPlaceholderText('com_ui_enter_api_key_optional')).toHaveValue(
      'retained-provider-secret',
    );
    expect(screen.getByPlaceholderText('com_ui_web_search_cohere_key')).toHaveValue(
      'retained-reranker-secret',
    );
    expect(screen.getByPlaceholderText('com_ui_web_search_cohere_key')).toHaveAttribute(
      'type',
      'password',
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedProvider: SearchProviders.KEENABLE,
          selectedScraper: ScraperProviders.FIRECRAWL,
          selectedReranker: RerankerTypes.COHERE,
          keenableApiUrl: 'https://search.example.test',
          keenableApiKey: 'retained-provider-secret',
          cohereApiKey: 'retained-reranker-secret',
        }),
      ),
    );
  });

  it.each(['triggerRef', 'triggerRefs'] as const)(
    'restores focus through %s after closing and reopening',
    async (triggerMode) => {
      mockUseGetStartupConfig.mockReturnValue({ data: {} });
      render(<DialogHarness triggerMode={triggerMode} />);
      const trigger = screen.getByRole('button', { name: triggerLabel });

      for (let opening = 0; opening < 2; opening++) {
        fireEvent.click(trigger);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
        await waitFor(() => expect(trigger).toHaveFocus());
      }
    },
  );

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
