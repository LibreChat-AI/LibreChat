import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelsConfig, TStartupConfig, TEndpointsConfig } from 'librechat-data-provider';
import { useEndpoints } from '../useEndpoints';

let mockModels: TModelsConfig = {};
let mockFetched = false;
const mockEndpoints = [
  'gateway',
  'personal',
  EModelEndpoint.agents,
  EModelEndpoint.assistants,
  EModelEndpoint.azureAssistants,
];
jest.mock('librechat-data-provider/react-query', () => ({
  useGetModelsQuery: () => ({ data: mockModels, isFetched: mockFetched, isSuccess: true }),
}));
jest.mock('~/data-provider', () => ({ useGetEndpointsQuery: () => ({ data: mockEndpoints }) }));
jest.mock('~/hooks', () => ({ useHasAccess: () => true, useShowMarketplace: () => true }));

it('hides empty providers only after discovery and restores them without losing configuration', () => {
  const endpointsConfig: TEndpointsConfig = {
    gateway: { userProvide: false, order: 0 },
    personal: { userProvide: true, order: 1 },
  };
  const startupConfig = { interface: { modelSelect: true } } as TStartupConfig;
  const { result, rerender } = renderHook(() => useEndpoints({ endpointsConfig, startupConfig }));
  expect(result.current.mappedEndpoints.map((endpoint) => endpoint.value)).toContain('gateway');
  mockFetched = true;
  mockModels = { gateway: [], personal: [] };
  rerender();
  expect(result.current.mappedEndpoints.map((endpoint) => endpoint.value)).toEqual(
    mockEndpoints.filter((endpoint) => endpoint !== 'gateway' && endpoint !== 'personal'),
  );
  expect(result.current.endpointRequiresUserKey('personal')).toBe(true);
  expect(endpointsConfig.gateway).toEqual({ userProvide: false, order: 0 });
  mockModels = { gateway: ['restored'], personal: [] };
  rerender();
  expect(
    result.current.mappedEndpoints.find((endpoint) => endpoint.value === 'gateway')?.models,
  ).toEqual([{ name: 'restored', isGlobal: false }]);
});
