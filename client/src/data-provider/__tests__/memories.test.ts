import axios from 'axios';
import { dataService as _dataService } from 'librechat-data-provider';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getMemories', () => {
  it('should fetch memories from /api/memories', async () => {
    const mockData = [{ key: 'foo', value: 'bar', updated_at: '2024-05-01T00:00:00Z' }];

    mockedAxios.get.mockResolvedValueOnce({ data: mockData } as any);

    const result = await (_dataService as any).getMemories();

    expect(mockedAxios.get).toHaveBeenCalledWith('/api/memories', expect.any(Object));
    expect(result).toEqual(mockData);
  });
});

describe('opaque memory management', () => {
  it('deletes a projected memory through its encoded id and agent partition', async () => {
    mockedAxios.delete.mockResolvedValueOnce({ data: { deleted: true } });

    await _dataService.deleteMemoryById('memory/id', 'agent id');

    expect(mockedAxios.delete).toHaveBeenCalledWith(
      '/api/memories/id/memory%2Fid?agentId=agent%20id',
    );
  });

  it('updates a projected memory without sending its hidden key', async () => {
    mockedAxios.patch.mockResolvedValueOnce({ data: { updated: true } });

    await _dataService.updateMemoryById('memory-id', 'replacement value', undefined, 'agent-id');

    expect(mockedAxios.patch).toHaveBeenCalledWith(
      '/api/memories/id/memory-id?agentId=agent-id',
      JSON.stringify({ value: 'replacement value' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  });

  it('sends an explicit replacement key only when supplied', async () => {
    mockedAxios.patch.mockResolvedValueOnce({ data: { updated: true } });

    await _dataService.updateMemoryById('memory-id', 'replacement value', 'replacement_key');

    expect(mockedAxios.patch).toHaveBeenCalledWith(
      '/api/memories/id/memory-id',
      JSON.stringify({ value: 'replacement value', key: 'replacement_key' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  });
});
