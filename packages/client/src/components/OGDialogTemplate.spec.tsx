import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { OGDialog, OGDialogContent, OGDialogTitle } from './OriginalDialog';
import OGDialogTemplate from './OGDialogTemplate';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/**
 * A dialog reads its edge, inline padding, header gap and title from theme roles. The template
 * cleared the edge with `border-none`, so a theme's stroke never reached a templated dialog.
 */
describe('OGDialog chrome roles', () => {
  it('lets the theme stroke and pad a templated dialog', () => {
    render(
      <OGDialog open={true}>
        <OGDialogTemplate title="Archive all chats" description="Archive every chat" />
      </OGDialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Archive all chats' });
    expect(dialog).toHaveClass(
      'border-(length:--theme-dialog-stroke)',
      'border-border-light',
      'px-theme-dialog-x',
    );
    expect(dialog).not.toHaveClass('border-none');
    expect(dialog.querySelector('.space-y-theme-dialog-header')).not.toBeNull();
  });

  it('sets the title from the dialog title roles', () => {
    render(
      <OGDialog open={true}>
        <OGDialogTemplate title="Archive all chats" />
      </OGDialog>,
    );

    expect(screen.getByRole('heading', { name: 'Archive all chats' })).toHaveClass(
      'text-(length:--theme-dialog-title-size)',
      'leading-(--theme-dialog-title-leading)',
      'font-theme-dialog-title',
      'font-theme-dialog-title-weight',
      'text-dialog-title',
    );
  });

  it('keeps a caller’s own title size, weight and padding over the roles', () => {
    render(
      <OGDialog open={true}>
        <OGDialogContent className="p-4">
          <OGDialogTitle className="text-sm font-medium">Rename</OGDialogTitle>
        </OGDialogContent>
      </OGDialog>,
    );

    const title = screen.getByRole('heading', { name: 'Rename' });
    expect(title).toHaveClass('text-sm', 'font-medium');
    expect(title).not.toHaveClass(
      'text-(length:--theme-dialog-title-size)',
      'leading-(--theme-dialog-title-leading)',
      'font-theme-dialog-title-weight',
    );
    const dialog = screen.getByRole('dialog', { name: 'Rename' });
    expect(dialog).toHaveClass('p-4');
    expect(dialog).not.toHaveClass('px-theme-dialog-x');
  });
});
