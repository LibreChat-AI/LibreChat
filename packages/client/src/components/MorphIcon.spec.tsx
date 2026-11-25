import React from 'react';
import { Download } from 'lucide';
import { render } from '@testing-library/react';
import { MorphIcon } from './MorphIcon';

/**
 * Migrated call sites rely on MorphIcon hiding itself from assistive technology
 * by default, the way the lucide icons it replaced were explicitly marked
 * `aria-hidden`. Guard that contract so a library change cannot silently expose
 * every decorative icon as a redundant graphic.
 */
describe('MorphIcon accessibility defaults', () => {
  it('hides the icon from assistive technology when no label is given', () => {
    const { container } = render(<MorphIcon icon={Download} size={16} />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
  });

  it('exposes the icon as a titled image when a label is given', () => {
    const { container } = render(<MorphIcon icon={Download} size={16} label="Download" />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).not.toHaveAttribute('aria-hidden');
    expect(container.querySelector('title')).toHaveTextContent('Download');
  });
});
