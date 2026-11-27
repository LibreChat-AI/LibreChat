import { useQuery } from '@tanstack/react-query';
import { useGetModelsQuery, useGetEndpointModelsQuery } from '../src/react-query';
import { initialModelsConfig } from '../src/config';
import { QueryKeys } from '../src/keys';

jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('../src/data-service', () => ({ getModels: jest.fn() }));

import { getModels } from '../src/data-service';

function queryCall() {
  const calls = jest.mocked(useQuery).mock.calls;
  return calls[calls.length - 1];
}

describe('model discovery query hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('gives each endpoint a distinct cache key and no fabricated initial catalog', () => {
    useGetEndpointModelsQuery('openAI');
    const [key, query, options] = queryCall();
    expect(key).toEqual([QueryKeys.models, 'openAI']);
    expect(options).not.toHaveProperty('initialData');
    expect(options).not.toHaveProperty('placeholderData');
    expect(options).toEqual(expect.objectContaining({ staleTime: Infinity, enabled: true }));
    (query as () => void)();
    expect(getModels).toHaveBeenCalledWith('openAI');

    useGetEndpointModelsQuery('anthropic');
    expect(queryCall()[0]).toEqual([QueryKeys.models, 'anthropic']);
  });

  it('lets callers disable scoped discovery and preserves query options', () => {
    useGetEndpointModelsQuery('openAI', { enabled: false, retry: false });
    expect(queryCall()[2]).toEqual(expect.objectContaining({ enabled: false, retry: false }));
  });

  it('never fetches an empty endpoint automatically', () => {
    useGetEndpointModelsQuery('', { enabled: true });
    expect(queryCall()[2]).toEqual(expect.objectContaining({ enabled: false }));
    expect(getModels).not.toHaveBeenCalled();
  });

  it('keeps aggregate observers backward compatible and explicitly disableable', () => {
    useGetModelsQuery({ enabled: false });
    const [key, query, options] = queryCall();
    expect(key).toEqual([QueryKeys.models]);
    expect(options).toEqual(
      expect.objectContaining({ initialData: initialModelsConfig, enabled: false }),
    );
    (query as () => void)();
    expect(getModels).toHaveBeenCalledWith();
  });
});
