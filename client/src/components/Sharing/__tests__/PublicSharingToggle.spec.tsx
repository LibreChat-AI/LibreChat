import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import PublicSharingToggle from '../PublicSharingToggle';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('../AccessRolesPicker', () => ({
  __esModule: true,
  default: () => <div />,
}));

describe('PublicSharingToggle', () => {
  it('uses the shared auto-height collapse and a transparent permission row', () => {
    const { rerender } = render(
      <PublicSharingToggle
        isPublic={false}
        onPublicToggle={jest.fn()}
        onPublicRoleChange={jest.fn()}
      />,
    );

    const permissionLabel = screen.getByText('com_ui_everyone_permission_level');
    const collapse = permissionLabel.closest('[aria-hidden="true"]');

    expect(collapse).toHaveClass('grid-rows-[0fr]');
    expect(permissionLabel.closest('.overflow-hidden')).toBeInTheDocument();

    rerender(
      <PublicSharingToggle
        isPublic={true}
        onPublicToggle={jest.fn()}
        onPublicRoleChange={jest.fn()}
      />,
    );

    expect(permissionLabel.closest('.bg-transparent')).toBeInTheDocument();
    expect(permissionLabel.closest('.bg-transparent')).not.toHaveClass('bg-surface-secondary/50');
    expect(permissionLabel.closest('.grid')).toHaveClass('grid-rows-[1fr]');
  });

  it('does not clip the open permission row, so the inline role menu can escape the box', () => {
    render(
      <PublicSharingToggle
        isPublic={true}
        onPublicToggle={jest.fn()}
        onPublicRoleChange={jest.fn()}
      />,
    );

    const permissionLabel = screen.getByText('com_ui_everyone_permission_level');
    expect(permissionLabel.closest('.overflow-hidden')).toBeNull();
    expect(permissionLabel.closest('.overflow-visible')).toBeInTheDocument();
  });
});
