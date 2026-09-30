import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TCategory } from 'librechat-data-provider';
import FilterPrompts from '../FilterPrompts';
import store from '~/store';

jest.mock('../../buttons/CreatePromptButton', () => ({
  __esModule: true,
  default: () => null,
}));

const mockGetCategories = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getCategories: () => mockGetCategories() },
  };
});

const categories: TCategory[] = [
  { value: 'hr', label: 'Human Resources', icon: 'users', color: 'series-7' },
  { value: 'idea', label: 'com_ui_idea' },
  { value: 'Onboarding', label: 'Onboarding', custom: true },
];

const CategoryProbe = () => (
  <span data-testid="category">{useRecoilValue(store.promptsCategory)}</span>
);

const renderFilter = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RecoilRoot>
        <FilterPrompts />
        <CategoryProbe />
      </RecoilRoot>
    </QueryClientProvider>,
  );

describe('FilterPrompts', () => {
  beforeEach(() => {
    mockGetCategories.mockResolvedValue(categories);
  });

  afterEach(() => {
    mockGetCategories.mockReset();
  });

  const openFilter = async () => {
    await waitFor(() => expect(mockGetCategories).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter Prompts' }));
    return screen.findByRole('option', { name: /Onboarding/ });
  };

  it('lists configured, localized and custom categories after the system entries', async () => {
    renderFilter();
    await openFilter();

    const names = screen.getAllByRole('option').map((o) => o.textContent?.trim());
    expect(names).toEqual(
      expect.arrayContaining([
        'All',
        'My Prompts',
        'Shared Prompts',
        'Human Resources',
        'Ideas',
        'Onboarding',
      ]),
    );
  });

  it('renders the configured icon and color for a configured category', async () => {
    renderFilter();
    await openFilter();

    const icon = screen.getByRole('option', { name: /Human Resources/ }).querySelector('svg');
    expect(icon).toHaveClass('lucide-users', 'text-series-7');
  });

  it('filters by a custom category when it is selected', async () => {
    renderFilter();
    fireEvent.click(await openFilter());

    await waitFor(() => expect(screen.getByTestId('category')).toHaveTextContent('Onboarding'));
  });
});
