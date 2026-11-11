import React from 'react';
import { render, screen } from '@testing-library/react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './HoverCard';

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
});
