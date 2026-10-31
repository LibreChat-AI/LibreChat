import { act, renderHook } from '@testing-library/react';
import { Tools, RerankerTypes, SearchProviders, ScraperProviders } from 'librechat-data-provider';
import type { SearchApiKeyFormData } from '../useAuthSearchTool';
import useSearchApiKeyForm from '../useSearchApiKeyForm';
import useAuthSearchTool from '../useAuthSearchTool';

const mockMutate = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockSetQueryData = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
    setQueryData: mockSetQueryData,
  }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useUpdateUserPluginsMutation: () => ({ mutate: mockMutate }),
}));

const emptyForm = (): SearchApiKeyFormData => ({
  kagiApiKey: '',
  serperApiKey: '',
  searxngInstanceUrl: '',
  searxngApiKey: '',
  firecrawlApiKey: '',
  firecrawlApiUrl: '',
  tavilyApiKey: '',
  keenableApiKey: '',
  keenableApiUrl: '',
  jinaApiKey: '',
  jinaApiUrl: '',
  cohereApiKey: '',
});

describe('useAuthSearchTool', () => {
  it('discards the Kagi key and dirty state when revoking access', () => {
    const { result } = renderHook(() => useSearchApiKeyForm({}));

    expect(result.current.methods.getValues('kagiApiKey')).toBeUndefined();
    act(() =>
      result.current.methods.setValue('kagiApiKey', 'kagi-test-key', { shouldDirty: true }),
    );
    act(() => result.current.handleRevokeApiKey());

    expect(result.current.methods.getValues('kagiApiKey')).toBeUndefined();
    expect(result.current.methods.formState.dirtyFields).toEqual({});
    expect(mockMutate).toHaveBeenCalledWith({
      pluginKey: Tools.web_search,
      action: 'uninstall',
      auth: {},
      isEntityTool: true,
    });
  });

  it('submits an explicitly cleared Kagi key through the real form', () => {
    const { result } = renderHook(() => useSearchApiKeyForm({}));
    act(() => result.current.methods.setValue('kagiApiKey', 'test-key', { shouldDirty: true }));
    act(() => result.current.methods.setValue('kagiApiKey', '', { shouldDirty: true }));
    act(() => result.current.onSubmit(result.current.methods.getValues()));

    expect(mockMutate).toHaveBeenCalledWith({
      pluginKey: Tools.web_search,
      action: 'install',
      auth: { kagiApiKey: '' },
      isEntityTool: true,
    });
  });

  it('submits Kagi credentials without changing the scraper or reranker', () => {
    const { result } = renderHook(() => useAuthSearchTool());

    act(() =>
      result.current.installTool({
        ...emptyForm(),
        selectedProvider: SearchProviders.KAGI,
        kagiApiKey: 'kagi-test-key',
        selectedScraper: ScraperProviders.FIRECRAWL,
        firecrawlApiKey: 'firecrawl-test-key',
        selectedReranker: RerankerTypes.JINA,
        jinaApiKey: 'jina-test-key',
      }),
    );

    expect(mockMutate).toHaveBeenCalledWith({
      pluginKey: Tools.web_search,
      action: 'install',
      auth: {
        selectedProvider: SearchProviders.KAGI,
        kagiApiKey: 'kagi-test-key',
        selectedScraper: ScraperProviders.FIRECRAWL,
        firecrawlApiKey: 'firecrawl-test-key',
        selectedReranker: RerankerTypes.JINA,
        jinaApiKey: 'jina-test-key',
      },
      isEntityTool: true,
    });
  });

  it.each([SearchProviders.SERPER, SearchProviders.KAGI])(
    'submits Kagi Extract with the shared key and search provider %s',
    (selectedProvider) => {
      const { result } = renderHook(() => useAuthSearchTool());

      act(() =>
        result.current.installTool({
          ...emptyForm(),
          selectedProvider,
          selectedScraper: ScraperProviders.KAGI,
          kagiApiKey: 'shared-kagi-test-key',
          selectedReranker: RerankerTypes.NONE,
        }),
      );

      expect(mockMutate).toHaveBeenCalledWith({
        pluginKey: Tools.web_search,
        action: 'install',
        auth: {
          selectedProvider,
          selectedScraper: 'kagi',
          kagiApiKey: 'shared-kagi-test-key',
          selectedReranker: RerankerTypes.NONE,
        },
        isEntityTool: true,
      });
    },
  );

  it('submits a Kagi key without overriding an admin-pinned provider or scraper', () => {
    const { result } = renderHook(() => useAuthSearchTool());

    act(() => result.current.installTool({ ...emptyForm(), kagiApiKey: 'kagi-test-key' }));

    expect(mockMutate).toHaveBeenCalledWith({
      pluginKey: Tools.web_search,
      action: 'install',
      auth: { kagiApiKey: 'kagi-test-key' },
      isEntityTool: true,
    });
  });

  it('omits a pristine empty Kagi key', () => {
    const { result } = renderHook(() => useAuthSearchTool());

    act(() => result.current.installTool(emptyForm()));

    expect(mockMutate).toHaveBeenCalledWith({
      pluginKey: Tools.web_search,
      action: 'install',
      auth: {},
      isEntityTool: true,
    });
  });

  it('forwards an explicitly cleared Kagi key', () => {
    const { result } = renderHook(() => useAuthSearchTool());

    act(() => result.current.installTool(emptyForm(), { kagiApiKey: true }));

    expect(mockMutate).toHaveBeenCalledWith({
      pluginKey: Tools.web_search,
      action: 'install',
      auth: { kagiApiKey: '' },
      isEntityTool: true,
    });
  });

  it('forwards an explicitly empty Keenable URL as a clear operation', () => {
    const { result } = renderHook(() => useAuthSearchTool());

    act(() => result.current.installTool(emptyForm(), { keenableApiUrl: true }));

    expect(mockMutate).toHaveBeenCalledWith({
      pluginKey: Tools.web_search,
      action: 'install',
      auth: { keenableApiUrl: '' },
      isEntityTool: true,
    });
  });

  it('omits a pristine empty Keenable URL', () => {
    const { result } = renderHook(() => useAuthSearchTool());

    act(() => result.current.installTool(emptyForm()));

    expect(mockMutate).toHaveBeenCalledWith({
      pluginKey: Tools.web_search,
      action: 'install',
      auth: {},
      isEntityTool: true,
    });
  });

  it('omits an undefined Keenable URL even when marked dirty', () => {
    const data = emptyForm();
    data.keenableApiUrl = undefined as unknown as string;
    const { result } = renderHook(() => useAuthSearchTool());

    act(() => result.current.installTool(data, { keenableApiUrl: true }));

    expect(mockMutate).toHaveBeenCalledWith({
      pluginKey: Tools.web_search,
      action: 'install',
      auth: {},
      isEntityTool: true,
    });
  });
});
