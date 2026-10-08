import { Tools } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import useAuthSearchTool, { type SearchApiKeyFormData } from '../useAuthSearchTool';

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
