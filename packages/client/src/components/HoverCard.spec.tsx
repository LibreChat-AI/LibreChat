import React from 'react';
import { render, screen } from '@testing-library/react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './HoverCard';
import { OGDialog, OGDialogContent, OGDialogTitle } from './OriginalDialog';

describe('HoverCardContent', () => {
  it('corners the panel with the menu panel role', () => {
    render(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <button type="button">Trigger</button>
        </HoverCardTrigger>
        <HoverCardContent>Details</HoverCardContent>
      </HoverCard>,
    );

    expect(screen.getByText('Details')).toHaveClass('rounded-theme-menu-panel');
  });

  it('skips the enter and exit animation under reduced motion', () => {
    render(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <button type="button">Trigger</button>
        </HoverCardTrigger>
        <HoverCardContent>Details</HoverCardContent>
      </HoverCard>,
    );

    expect(screen.getByText('Details')).toHaveClass(
      'motion-reduce:data-[state=open]:animate-none',
      'motion-reduce:data-[state=closed]:animate-none',
    );
  });

  it('keeps the light border on the page', () => {
    render(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <button type="button">Trigger</button>
        </HoverCardTrigger>
        <HoverCardContent>Details</HoverCardContent>
      </HoverCard>,
    );

    expect(screen.getByText('Details')).toHaveClass('border-border-light');
    expect(screen.getByText('Details')).not.toHaveClass('border-border-medium');
  });

  it('draws a medium border when it opens over a dialog', () => {
    render(
      <OGDialog open>
        <OGDialogContent aria-describedby={undefined}>
          <OGDialogTitle>Dialog</OGDialogTitle>
          <HoverCard open>
            <HoverCardTrigger asChild>
              <button type="button">Trigger</button>
            </HoverCardTrigger>
            <HoverCardContent>Details</HoverCardContent>
          </HoverCard>
        </OGDialogContent>
      </OGDialog>,
    );

    expect(screen.getByText('Details')).toHaveClass('border-border-medium');
    expect(screen.getByText('Details')).not.toHaveClass('border-border-light');
  });
});
