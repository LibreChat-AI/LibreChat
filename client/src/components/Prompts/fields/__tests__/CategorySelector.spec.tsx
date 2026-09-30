import React from 'react';
import { RecoilRoot } from 'recoil';
import '@testing-library/jest-dom/extend-expect';
import { FormProvider, useForm } from 'react-hook-form';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TCategory } from 'librechat-data-provider';
import { useGetCategories, useUpdatePromptGroup } from '~/data-provider';
import CategorySelector from '../CategorySelector';

const mockGetCategories = jest.fn();
const mockGetStartupConfig = jest.fn();
const mockUpdatePromptGroup = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getCategories: () => mockGetCategories(),
      getStartupConfig: () => mockGetStartupConfig(),
      updatePromptGroup: (vars: unknown) => mockUpdatePromptGroup(vars),
    },
  };
});

const categories: TCategory[] = [
  { value: 'hr', label: 'Human Resources' },
  { value: 'idea', label: 'com_ui_idea' },
];

let formValues: { category?: string } = {};

const FormProbe = () => {
  const methods = useForm({ defaultValues: { category: '' } });
  formValues = methods.watch();
  return (
    <FormProvider {...methods}>
      <CategorySelector portal={false} />
    </FormProvider>
  );
};

const renderSelector = (allowCustom?: boolean) => {
  mockGetStartupConfig.mockResolvedValue(
    allowCustom === undefined ? {} : { promptCategories: { allowCustom } },
  );
  const queryClient = new QueryClient();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <FormProbe />
      </RecoilRoot>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
};

const openMenu = async () => {
  await waitFor(() => expect(mockGetCategories).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /category/i }));
};

const openForm = async () => {
  await openMenu();
  fireEvent.click(await screen.findByRole('menuitem', { name: /New category/ }));
  return screen.findByRole('textbox', { name: 'Category name' });
};

describe('CategorySelector custom categories', () => {
  beforeEach(() => {
    formValues = {};
    mockGetCategories.mockResolvedValue(categories);
  });

  afterEach(() => {
    mockGetCategories.mockReset();
    mockGetStartupConfig.mockReset();
    mockUpdatePromptGroup.mockReset();
    localStorage.clear();
  });

  it('creates a category from the keyboard and shows it in the trigger', async () => {
    renderSelector(true);
    const input = await openForm();
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.change(input, { target: { value: 'Onboarding' } });
    expect(screen.getByRole('button', { name: 'Create “Onboarding”' })).toBeEnabled();
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(formValues.category).toBe('Onboarding'));
    expect(screen.getByRole('button', { name: /category/i })).toHaveTextContent('Onboarding');
    expect(screen.queryByRole('textbox', { name: 'Category name' })).not.toBeInTheDocument();
  });

  it('closes the form on Escape and returns focus to the trigger', async () => {
    renderSelector(true);
    const input = await openForm();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: 'Category name' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /category/i })).toHaveFocus();
  });

  it.each([' hr ', 'human resources'])('reuses the existing category for %p', async (typed) => {
    renderSelector(true);
    const input = await openForm();

    fireEvent.change(input, { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Use “Human Resources”' }));

    await waitFor(() => expect(formValues.category).toBe('hr'));
  });

  it.each([
    ['sys__x', 'reserved'],
    ['a'.repeat(101), 'too long'],
  ])('disables creation for %p and links the reason', async (typed, reason) => {
    renderSelector(true);
    const input = await openForm();

    fireEvent.change(input, { target: { value: typed } });

    const button = screen.getByRole('button', { name: /^Create/ });
    expect(button).toBeDisabled();
    const describedBy = button.getAttribute('aria-describedby') ?? '';
    const message = document.getElementById(describedBy);
    expect(message).toHaveTextContent(new RegExp(reason === 'reserved' ? 'sys__' : '100'));
  });

  it('offers no new-category item when custom categories are not allowed', async () => {
    renderSelector(false);
    await openMenu();

    await screen.findByRole('menuitem', { name: /Human Resources/ });
    expect(screen.queryByRole('menuitem', { name: /New category/ })).not.toBeInTheDocument();
  });
});

describe('categories invalidation after saving a group', () => {
  it('refetches categories after a group update', async () => {
    mockGetCategories.mockResolvedValue(categories);
    mockUpdatePromptGroup.mockResolvedValue({ _id: 'g1' });
    const Harness = () => {
      useGetCategories();
      const { mutate } = useUpdatePromptGroup();
      return (
        <button
          data-testid="save"
          onClick={() => mutate({ id: 'g1', payload: { category: 'x' } })}
        />
      );
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RecoilRoot>
          <Harness />
        </RecoilRoot>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mockGetCategories).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('save'));

    await waitFor(() => expect(mockGetCategories).toHaveBeenCalledTimes(2));
  });
});
