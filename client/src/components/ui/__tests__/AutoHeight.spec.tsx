import React from 'react';
import { render, screen } from '@testing-library/react';
import AutoHeight from '../AutoHeight';

describe('AutoHeight', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps caller class overrides when the shared component merges classes', () => {
    render(
      <AutoHeight className="overflow-visible duration-150">
        <p>{'Override layout'}</p>
      </AutoHeight>,
    );
    const clip = screen.getByText('Override layout').parentElement?.parentElement;
    expect(clip).toHaveClass('overflow-visible', 'duration-150');
    expect(clip).not.toHaveClass('overflow-hidden', 'duration-300');
  });

  it('sizes the clip box to the measured content, fractions included', () => {
    jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 87.5 } as DOMRect);

    render(
      <AutoHeight>
        <p>{'Which time window?'}</p>
      </AutoHeight>,
    );

    const content = screen.getByText('Which time window?').parentElement as HTMLElement;
    const clip = content.parentElement as HTMLElement;
    expect(clip.style.height).toBe('87.5px');
    expect(clip).toHaveClass('overflow-hidden', 'transition-all', 'motion-reduce:transition-none');
  });
});
