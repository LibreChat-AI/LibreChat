import React from 'react';
import { dataService } from 'librechat-data-provider';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import useCategories from '../useCategories';

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: { getCategories: jest.fn() },
}));

const getCategories = dataService.getCategories as jest.Mock;

const renderCategories = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useCategories({}), { wrapper });
};

describe('useCategories', () => {
  afterEach(() => getCategories.mockReset());

  it('localizes com_ keys, keeps literal labels, and falls back to the value', async () => {
    getCategories.mockResolvedValue([
      { value: 'idea', label: 'com_ui_idea' },
      { value: 'hr-team', label: 'Human Resources', custom: true },
      { value: 'bare' },
    ] as never);
    const { result } = renderCategories();

    await waitFor(() => expect(result.current.categories).toHaveLength(3));
    const [idea, hr, bare] = result.current.categories as {
      label: string;
      custom?: boolean;
    }[];
    expect(idea.label).toBe('Ideas');
    expect(hr.label).toBe('Human Resources');
    expect(hr.custom).toBe(true);
    expect(bare.label).toBe('bare');
    expect(idea.custom).toBeUndefined();
  });

  it('keeps the loading placeholder when the request is rejected', async () => {
    getCategories.mockRejectedValue(new Error('boom'));
    const { result } = renderCategories();

    await waitFor(() => expect(getCategories).toHaveBeenCalled());
    expect(result.current.categories).toEqual([{ label: 'com_ui_loading', value: '' }]);
  });
});
