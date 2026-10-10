import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './AlertDialog';
import { OGDialog, OGDialogContent, OGDialogDescription, OGDialogTitle } from './OriginalDialog';

describe('AlertDialog dialog depth', () => {
  it('renders its portal above an open OGDialog', () => {
    render(
      <OGDialog open={true}>
        <OGDialogContent>
          <OGDialogTitle>Passkeys</OGDialogTitle>
          <OGDialogDescription>Manage passkeys</OGDialogDescription>
          <AlertDialog>
            <AlertDialogTrigger>Remove</AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogTitle>Remove passkey?</AlertDialogTitle>
              <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
            </AlertDialogContent>
          </AlertDialog>
        </OGDialogContent>
      </OGDialog>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const alertDialog = screen.getByRole('alertdialog', { name: 'Remove passkey?' });
    const portalLayer = alertDialog.parentElement;
    const overlay = alertDialog.previousElementSibling;

    expect(portalLayer).toHaveStyle({ zIndex: 190 });
    expect(overlay).toHaveStyle({ zIndex: 190 });
    expect(alertDialog).toHaveStyle({ zIndex: 200 });
  });
});
