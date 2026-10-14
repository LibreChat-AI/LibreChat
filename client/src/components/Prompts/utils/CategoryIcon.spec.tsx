import React from 'react';
import { render } from '@testing-library/react';
import CategoryIcon from './CategoryIcon';

const categoryColors = {
  code: 'text-category-icon-5',
  misc: 'text-category-icon-1',
  shop: 'text-category-icon-6',
  idea: 'text-category-icon-4',
  write: 'text-category-icon-6',
  travel: 'text-category-icon-4',
  finance: 'text-category-icon-2',
  roleplay: 'text-category-icon-2',
  teach_or_explain: 'text-category-icon-1',
  general: 'text-category-icon-1',
  hr: 'text-category-icon-7',
  rd: 'text-category-icon-6',
  it: 'text-category-icon-5',
  sales: 'text-category-icon-2',
  aftersales: 'text-category-icon-4',
};

describe('CategoryIcon', () => {
  it.each(Object.entries(categoryColors))(
    'uses the semantic color role for %s',
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
