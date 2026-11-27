import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { activateCatalog, resetCatalogWarmup } from '../../useCatalogWarmup';
import { useMCPIconMap, useMCPServerNames } from '../useMCPIconMap';

const mockUseMCPServersQuery = jest.fn();
jest.mock('~/data-provider', () => ({
  useMCPServersQuery: (config: unknown) => mockUseMCPServersQuery(config),
}));

describe('useMCPIconMap', () => {
  beforeEach(() => {
    resetCatalogWarmup();
    mockUseMCPServersQuery.mockReturnValue({ data: undefined });
    mockUseMCPServersQuery.mockClear();
  });

  it('keeps the servers query disabled until warmup releases the catalog', () => {
    renderHook(() => {
      useMCPIconMap();
      useMCPServerNames();
    });

    expect(mockUseMCPServersQuery).toHaveBeenCalledWith({ enabled: false });
  });

  it('enables the servers query once the catalog is active', () => {
    renderHook(() => {
      useMCPIconMap();
      useMCPServerNames();
    });
    expect(mockUseMCPServersQuery).toHaveBeenLastCalledWith({ enabled: false });

    act(() => {
      activateCatalog('mcpServers');
    });

    expect(mockUseMCPServersQuery).toHaveBeenLastCalledWith({ enabled: true });
  });
});
