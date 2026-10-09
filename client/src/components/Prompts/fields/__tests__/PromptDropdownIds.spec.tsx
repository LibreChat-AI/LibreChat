import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { FormProvider, useForm } from 'react-hook-form';
import { fireEvent, render, screen } from '@testing-library/react';
import VariablesDropdown from '../../editor/VariablesDropdown';
import CategorySelector from '../CategorySelector';

const mockAnnouncePolite = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useCategories: () => ({
    categories: [{ value: 'general', label: 'General' }],
    emptyCategory: { value: '', label: 'Empty' },
  }),
}));

jest.mock('~/Providers', () => ({
  usePromptGroupsContext: () => ({ hasAccess: true }),
  useLiveAnnouncer: () => ({ announcePolite: mockAnnouncePolite }),
}));

function PromptControls() {
  const methods = useForm({
    defaultValues: { category: '', prompt: '' },
  });

  return (
    <FormProvider {...methods}>
      <CategorySelector portal={false} />
      <VariablesDropdown portal={false} />
    </FormProvider>
  );
}

function getAttribute(element: HTMLElement, name: string) {
  const value = element.getAttribute(name);
  expect(value).not.toBeNull();
  return value ?? '';
}

function getElementsWithId(container: HTMLElement, id: string) {
  return Array.from(container.querySelectorAll<HTMLElement>('[id]')).filter(
    (element) => element.id === id,
  );
}

describe('prompt dropdown IDs', () => {
  it('keeps menu relationships unique when multiple prompt forms are mounted', () => {
    const { container } = render(
      <>
        <PromptControls />
        <PromptControls />
      </>,
    );

    const categoryTriggers = screen.getAllByRole('button', {
      name: 'com_ui_prompt_category_selector_aria',
    });
    const categoryMenuIds = categoryTriggers.map((trigger) =>
      getAttribute(trigger, 'aria-controls'),
    );

    expect(new Set(categoryMenuIds).size).toBe(categoryMenuIds.length);
    categoryTriggers.forEach((trigger, index) => {
      const menus = getElementsWithId(container, categoryMenuIds[index]);
      expect(menus).toHaveLength(1);
      expect(menus[0]).toHaveAttribute('aria-labelledby', trigger.id);
    });

    const categoryItems = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const categoryItemIds = categoryItems.map((item) => item.id);
    expect(categoryItemIds.every(Boolean)).toBe(true);
    expect(new Set(categoryItemIds).size).toBe(categoryItemIds.length);

    const variableTriggers = screen.getAllByRole('button', {
      name: 'com_ui_add_special_variables',
    });
    const variableTriggerIds = variableTriggers.map((trigger) => trigger.id);
    expect(variableTriggerIds.every(Boolean)).toBe(true);
    expect(new Set(variableTriggerIds).size).toBe(variableTriggerIds.length);

    variableTriggers.forEach((trigger) => fireEvent.click(trigger));

    const variableMenuIds = variableTriggers.map((trigger) =>
      getAttribute(trigger, 'aria-controls'),
    );
    expect(new Set(variableMenuIds).size).toBe(variableMenuIds.length);
    variableTriggers.forEach((trigger, index) => {
      const menus = getElementsWithId(container, variableMenuIds[index]);
      expect(menus).toHaveLength(1);
      expect(menus[0]).toHaveAttribute('aria-labelledby', trigger.id);
    });
  });
});
