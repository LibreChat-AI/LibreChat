import { render, screen } from '@testing-library/react';
import type { Endpoint, SelectedValues } from '~/common';
import { EndpointMenuContentByMode, isFlatEndpointDropdown } from '../EndpointMenuContentByMode';

const mockRenderSearchResults = jest.fn();

jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => ({
  CustomMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('..', () => ({
  EndpointMenuContent: ({ endpoint }: { endpoint: Endpoint }) => (
    <div>{`endpoint:${endpoint.label}`}</div>
  ),
  renderSearchResults: (...args: unknown[]) => mockRenderSearchResults(...args),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const selectedValues: SelectedValues = {
  endpoint: '',
  model: '',
  modelSpec: '',
};

const mappedEndpoints: Endpoint[] = [
  {
    value: 'anthropic',
    label: 'Anthropic',
    hasModels: true,
    models: [{ name: 'claude-opus-4-6' }],
    icon: null,
  },
  {
    value: 'openai',
    label: 'OpenAI',
    hasModels: true,
    models: [{ name: 'gpt-5' }],
    icon: null,
  },
];

describe('EndpointMenuContentByMode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRenderSearchResults.mockReturnValue(<div>{'search-results'}</div>);
  });

  describe('isFlatEndpointDropdown', () => {
    it('returns true for flat mode regardless of endpoint count', () => {
      expect(isFlatEndpointDropdown('flat', mappedEndpoints)).toBe(true);
      expect(isFlatEndpointDropdown('flat', [mappedEndpoints[0]])).toBe(true);
    });

    it('returns true for auto mode with a single endpoint', () => {
      expect(isFlatEndpointDropdown('auto', [mappedEndpoints[0]])).toBe(true);
    });

    it('returns false for auto mode with multiple endpoints and for other modes', () => {
      expect(isFlatEndpointDropdown('auto', mappedEndpoints)).toBe(false);
      expect(isFlatEndpointDropdown('nested', [mappedEndpoints[0]])).toBe(false);
      expect(isFlatEndpointDropdown(undefined, [mappedEndpoints[0]])).toBe(false);
    });
  });

  it('renders global search results in flat mode when search results are present', () => {
    render(
      <EndpointMenuContentByMode
        mode="flat"
        selectedValues={selectedValues}
        onValuesChange={jest.fn()}
        setSearchValue={jest.fn()}
        mappedEndpoints={mappedEndpoints}
        searchResults={[mappedEndpoints[0]]}
        searchValue="claude"
        trigger={<button type="button">{'trigger'}</button>}
      />,
    );

    expect(mockRenderSearchResults).toHaveBeenCalledWith(
      [mappedEndpoints[0]],
      expect.any(Function),
      'claude',
    );
    expect(screen.getByText('search-results')).toBeInTheDocument();
    expect(screen.queryByText('endpoint:Anthropic')).not.toBeInTheDocument();
    expect(screen.queryByText('endpoint:OpenAI')).not.toBeInTheDocument();
  });

  it('renders per-endpoint content in flat mode when not searching', () => {
    render(
      <EndpointMenuContentByMode
        mode="flat"
        selectedValues={selectedValues}
        onValuesChange={jest.fn()}
        setSearchValue={jest.fn()}
        mappedEndpoints={mappedEndpoints}
        searchResults={null}
        searchValue=""
        trigger={<button type="button">{'trigger'}</button>}
      />,
    );

    expect(mockRenderSearchResults).not.toHaveBeenCalled();
    expect(screen.getByText('endpoint:Anthropic')).toBeInTheDocument();
    expect(screen.getByText('endpoint:OpenAI')).toBeInTheDocument();
  });

  it('renders global search results in auto mode when search results are present', () => {
    render(
      <EndpointMenuContentByMode
        mode="auto"
        selectedValues={selectedValues}
        onValuesChange={jest.fn()}
        setSearchValue={jest.fn()}
        mappedEndpoints={[mappedEndpoints[0]]}
        searchResults={[mappedEndpoints[0]]}
        searchValue="claude"
        trigger={<button type="button">{'trigger'}</button>}
      />,
    );

    expect(mockRenderSearchResults).toHaveBeenCalledWith(
      [mappedEndpoints[0]],
      expect.any(Function),
      'claude',
    );
    expect(screen.getByText('search-results')).toBeInTheDocument();
    expect(screen.queryByText('endpoint:Anthropic')).not.toBeInTheDocument();
  });

  it('renders endpoint content in auto mode when not searching and only one endpoint is available', () => {
    render(
      <EndpointMenuContentByMode
        mode="auto"
        selectedValues={selectedValues}
        onValuesChange={jest.fn()}
        setSearchValue={jest.fn()}
        mappedEndpoints={[mappedEndpoints[0]]}
        searchResults={null}
        searchValue=""
        trigger={<button type="button">{'trigger'}</button>}
      />,
    );

    expect(mockRenderSearchResults).not.toHaveBeenCalled();
    expect(screen.getByText('endpoint:Anthropic')).toBeInTheDocument();
  });
});
