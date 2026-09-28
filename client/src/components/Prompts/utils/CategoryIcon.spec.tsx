import React from 'react';
import { render } from '@testing-library/react';
import CategoryIcon from './CategoryIcon';

const categoryColors = {
  code: 'text-series-5',
  misc: 'text-series-1',
  shop: 'text-series-6',
  idea: 'text-series-4',
  write: 'text-series-6',
  travel: 'text-series-4',
  finance: 'text-series-2',
  roleplay: 'text-series-2',
  teach_or_explain: 'text-series-1',
  general: 'text-series-1',
  hr: 'text-series-7',
  rd: 'text-series-6',
  it: 'text-series-5',
  sales: 'text-series-2',
  aftersales: 'text-series-4',
};

describe('CategoryIcon', () => {
  it.each(Object.entries(categoryColors))(
    'uses the semantic series color for %s',
    (category, color) => {
      const { container } = render(<CategoryIcon category={category} />);
      const icon = container.querySelector('svg');

      expect(icon).toHaveClass(color);
      expect(icon?.getAttribute('class')).not.toMatch(
        /(?:dark:)?text-(?:red|blue|purple|yellow|orange|green)-/,
      );
    },
  );

  it('uses secondary text for an unknown category', () => {
    const { container } = render(<CategoryIcon category="unknown" />);

    expect(container.querySelector('svg')).toHaveClass('text-text-secondary');
  });
});
