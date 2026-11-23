import { render, screen } from '@testing-library/react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './Collapsible';

const renderPair = (trigger: { appearance?: 'disclosure' }, content: { motion?: 'height' }) =>
  render(
    <Collapsible defaultOpen>
      <CollapsibleTrigger {...trigger} className="group">
        Toggle
      </CollapsibleTrigger>
      <CollapsibleContent {...content} className="overflow-hidden" data-testid="panel">
        Body
      </CollapsibleContent>
    </Collapsible>,
  );

describe('Collapsible', () => {
  it('adds no appearance or motion unless asked', () => {
    renderPair({}, {});

    expect(screen.getByRole('button', { name: 'Toggle' })).toHaveAttribute('class', 'group');
    expect(screen.getByTestId('panel')).toHaveAttribute('class', 'overflow-hidden');
  });

  it('gives a disclosure trigger its focus ring and shape beside the caller layout', () => {
    renderPair({ appearance: 'disclosure' }, {});

    expect(screen.getByRole('button', { name: 'Toggle' })).toHaveClass(
      'group',
      'focus-visible:ring-text-primary',
      'focus-visible:ring-2',
      'rounded-sm',
      'gap-2',
    );
  });

  it('rolls a height-motion panel, skipping the roll under reduced motion', () => {
    renderPair({}, { motion: 'height' });

    expect(screen.getByTestId('panel')).toHaveClass(
      'overflow-hidden',
      'data-[state=open]:animate-collapsible-down',
      'data-[state=closed]:animate-collapsible-up',
      'motion-reduce:data-[state=open]:animate-none',
      'motion-reduce:data-[state=closed]:animate-none',
    );
  });
});
