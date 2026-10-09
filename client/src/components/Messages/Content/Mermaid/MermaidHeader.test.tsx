import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import MermaidHeader from './MermaidHeader';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

jest.mock('~/components/Messages/Content/CopyButton', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: ReactModule.forwardRef<HTMLButtonElement>(() => null),
  };
});

jest.mock('@librechat/client', () => {
  const { createMermaidViewMorphIconMock } = jest.requireActual('~/../test/mockMorphIcon');
  return {
    ...jest.requireActual('@librechat/client'),
    MorphIcon: createMermaidViewMorphIconMock(),
  };
});

describe('MermaidHeader', () => {
  it('uses code and preview icons for the exclusive view action', async () => {
    const user = userEvent.setup();
    const onToggleCode = jest.fn();
    const { rerender } = render(
      <MermaidHeader
        codeContent={'graph TD\nA-->B'}
        showCode={false}
        onToggleCode={onToggleCode}
      />,
    );

    const showCodeButton = screen.getByRole('button', { name: 'com_ui_show_code' });
    expect(showCodeButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('morph-icon')).toHaveAttribute('data-icon', 'code-2');
    await user.click(showCodeButton);
    expect(onToggleCode).toHaveBeenCalledTimes(1);

    rerender(
      <MermaidHeader codeContent={'graph TD\nA-->B'} showCode={true} onToggleCode={onToggleCode} />,
    );

    const showPreviewButton = screen.getByRole('button', { name: 'com_ui_preview' });
    expect(showPreviewButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('morph-icon')).toHaveAttribute('data-icon', 'eye');
  });
});
