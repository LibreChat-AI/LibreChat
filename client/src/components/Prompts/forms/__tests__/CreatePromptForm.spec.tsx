import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import CreatePromptForm from '../CreatePromptForm';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
}));
jest.mock('~/hooks/Nav/useDrawerViewport', () => ({ __esModule: true, default: () => false }));
jest.mock('~/Providers', () => ({ usePromptGroupsContext: () => ({ hasAccess: true }) }));
jest.mock('~/data-provider', () => ({
  useCreatePrompt: () => ({ mutate: jest.fn(), isLoading: false }),
}));
jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({ __esModule: true, default: () => null }));
jest.mock('../../editor/VariablesDropdown', () => ({ __esModule: true, default: () => null }));
jest.mock('../../display/PromptVariables', () => ({ __esModule: true, default: () => null }));
jest.mock('../../fields/Description', () => ({ __esModule: true, default: () => null }));
jest.mock('../../fields/Command', () => ({ __esModule: true, default: () => null }));
jest.mock('../../fields/CategorySelector', () => ({
  __esModule: true,
  default: ({ className }: { className?: string }) => (
    <div data-testid="category" className={className} />
  ),
}));

const renderForm = (isDialog: boolean) =>
  render(
    <MemoryRouter>
      <CreatePromptForm isDialog={isDialog} />
    </MemoryRouter>,
  );

describe('CreatePromptForm', () => {
  it('notches the name label with the dialog surface, not a darker one, inside a dialog', () => {
    renderForm(true);
    const label = screen.getByText('com_ui_prompt_name*', { selector: 'label' });
    expect(label).toHaveClass('bg-surface-dialog');
    expect(label).not.toHaveClass('bg-surface-primary');
  });

  it('keeps the page surface on the page', () => {
    renderForm(false);
    expect(screen.getByText('com_ui_prompt_name*', { selector: 'label' })).toHaveClass(
      'bg-surface-primary-alt',
    );
  });

  it('draws the prompt text frame and the category picker with the same inset border', () => {
    const { container } = renderForm(true);
    const frames = container.querySelectorAll('header.rounded-t-xl, div.rounded-b-xl');
    expect(frames).toHaveLength(2);
    frames.forEach((frame) => expect(frame).toHaveClass('border-border-inset-medium'));
    expect(screen.getAllByTestId('category')[0]).toHaveClass('border-border-inset-medium');
  });
});
