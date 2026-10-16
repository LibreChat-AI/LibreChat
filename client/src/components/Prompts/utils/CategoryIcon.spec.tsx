import React from 'react';
import { render } from '@testing-library/react';
import { QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TCategory } from 'librechat-data-provider';
import CategoryIcon from './CategoryIcon';

const renderIcon = (category: string, configured: TCategory[] = []) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.categories], configured);
  return render(
    <QueryClientProvider client={queryClient}>
      <CategoryIcon category={category} />
    </QueryClientProvider>,
  );
};

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
      const { container } = renderIcon(category);
      const icon = container.querySelector('svg');

      expect(icon).toHaveClass(color);
      expect(icon?.getAttribute('class')).not.toMatch(
        /(?:dark:)?text-(?:red|blue|purple|yellow|orange|green)-/,
      );
    },
  );

  it('uses secondary text for an unknown category', () => {
    const { container } = renderIcon('unknown');

    expect(container.querySelector('svg')).toHaveClass('text-text-secondary');
  });

  it('uses the configured icon and color over the built-in maps', () => {
    const { container } = renderIcon('hr-team', [
      { value: 'hr-team', label: 'HR', icon: 'users', color: 'series-7' },
    ]);
    const icon = container.querySelector('svg');

    expect(icon).toHaveClass('lucide-users', 'text-series-7');
  });

  it('falls back to the file icon for an unknown value', () => {
    const { container } = renderIcon('unknown');

    expect(container.querySelector('svg')).toHaveClass('lucide-file-text', 'text-text-secondary');
  });

  it('keeps the built-in icon and color when the config has no entry', () => {
    const { container } = renderIcon('code', [{ value: 'other', label: 'Other' }]);

    expect(container.querySelector('svg')).toHaveClass(
      'lucide-square-terminal',
      'text-category-icon-5',
    );
  });
});
