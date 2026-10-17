import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import CategorySelector from '../CategorySelector';

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
}));

describe('CategorySelector disabled', () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.clearAllMocks();
  });

  it('disables the trigger so it cannot be opened', () => {
    const onValueChange = jest.fn();

    render(
      <CategorySelector portal={false} disabled onValueChange={onValueChange} currentCategory="" />,
    );

    const trigger = screen.getByRole('button', {
      name: 'com_ui_prompt_category_selector_aria',
    });
    // A real `disabled` button rejects pointer interaction entirely (userEvent
    // throws rather than opening the menu), so the trigger truly can't be used.
    expect(trigger).toBeDisabled();

    expect(screen.queryByRole('menuitem', { name: 'General' })).not.toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('lastPromptCategory')).toBeNull();
  });

  it('opens the menu and writes to localStorage when not disabled', async () => {
    const user = userEvent.setup();
    const onValueChange = jest.fn();

    render(<CategorySelector portal={false} onValueChange={onValueChange} currentCategory="" />);

    const trigger = screen.getByRole('button', {
      name: 'com_ui_prompt_category_selector_aria',
    });
    expect(trigger).not.toBeDisabled();

    await user.click(trigger);
    const item = await screen.findByRole('menuitem', { name: 'General' });
    await user.click(item);

    expect(onValueChange).toHaveBeenCalledWith('general');
    expect(window.localStorage.getItem('lastPromptCategory')).toBe('general');
  });
});
