import React from 'react';
import { RecoilRoot } from 'recoil';
import { useForm, FormProvider } from 'react-hook-form';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CategorySelector from '../CategorySelector';

const mockGetCategories = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getCategories: () => mockGetCategories() },
  };
});

let currentCategory: string | undefined;

const Harness = () => {
  const methods = useForm({ defaultValues: { category: '' } });
  currentCategory = methods.watch('category');
  return (
    <FormProvider {...methods}>
      <CategorySelector />
    </FormProvider>
  );
};

describe('Skills CategorySelector', () => {
  beforeEach(() => {
    currentCategory = undefined;
    mockGetCategories.mockResolvedValue([{ value: 'legal', label: 'Legal Team' }]);
  });

  afterEach(() => {
    mockGetCategories.mockReset();
  });

  const openMenu = async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RecoilRoot>
          <Harness />
        </RecoilRoot>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mockGetCategories).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Category' }));
    return screen.findByRole('menuitem', { name: /Legal Team/ });
  };

  it('lists a configured label verbatim and sets the form category on click', async () => {
    fireEvent.click(await openMenu());

    await waitFor(() => expect(currentCategory).toBe('legal'));
  });

  it('offers only the listed categories, with no create option', async () => {
    await openMenu();

    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  });
});
