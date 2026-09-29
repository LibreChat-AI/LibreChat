import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import CopyButton from '../CopyButton';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => {
  const { createCopyCheckMorphIconMock } = jest.requireActual('~/../test/mockMorphIcon');
  return {
    MorphIcon: createCopyCheckMorphIconMock(),
    TooltipAnchor: ({ render }: { render: React.ReactElement }) => render,
  };
});

describe('CopyButton', () => {
  it('renders the copy icon when not copied', () => {
    render(<CopyButton isCopied={false} onClick={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'com_ui_copy' })).toBeInTheDocument();
    expect(screen.getByTestId('morph-icon')).toHaveAttribute('data-icon', 'copy');
    expect(screen.getByTestId('morph-icon')).toHaveAttribute('data-size', '18');
  });

  it('renders the check icon when copied', () => {
    render(<CopyButton isCopied onClick={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'com_ui_copied' })).toBeInTheDocument();
    expect(screen.getByTestId('morph-icon')).toHaveAttribute('data-icon', 'check');
  });

  it('invokes onClick when pressed', () => {
    const onClick = jest.fn();
    render(<CopyButton isCopied={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_copy' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
