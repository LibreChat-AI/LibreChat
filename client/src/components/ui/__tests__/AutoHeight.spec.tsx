import React from 'react';
import { render, screen } from '@testing-library/react';
import AutoHeight from '../AutoHeight';

describe('AutoHeight', () => {
  afterEach(() => {
    jest.restoreAllMocks();
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
