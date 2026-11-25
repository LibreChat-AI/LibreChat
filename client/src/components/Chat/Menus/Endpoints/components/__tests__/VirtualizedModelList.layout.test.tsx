import { render } from '@testing-library/react';
import type { Endpoint } from '~/common';
import VirtualizedModelList from '../VirtualizedModelList';

jest.mock('@ariakit/react', () => ({
  useComboboxContext: () => null,
}));

jest.mock('../EndpointModelItem', () => ({
  EndpointModelItem: ({ modelId }: { modelId: string }) => (
    <div role="option" aria-selected="false">
      {modelId}
    </div>
  ),
}));

const endpoint: Endpoint = {
  value: 'openrouter',
  label: 'OpenRouter',
  hasModels: true,
  models: [],
  icon: null,
};

it('keeps virtualized rows visible when AutoSizer uses a zero-width wrapper', () => {
  let containerWidth = 300;
  jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute('data-endpoint-models') ? containerWidth : 0;
  });

  const modelIds = Array.from({ length: 150 }, (_, index) => `model-${index}`);
  const props = {
    endpoint,
    modelIds,
    globalByName: new Map<string, boolean>(),
    isFavorite: () => false,
    onToggleFavorite: () => undefined,
    precedingOptionCount: 0,
  };
  const { container, rerender } = render(<VirtualizedModelList {...props} key="all" />);
  const grid = container.querySelector<HTMLElement>('.ReactVirtualized__Grid');

  expect(grid?.parentElement).toHaveStyle({ width: '0px' });
  expect(grid).toHaveStyle({ width: '300px' });
  expect(container.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
  expect(container.querySelectorAll('[role="option"]').length).toBeLessThan(modelIds.length);

  containerWidth = 420;
  rerender(<VirtualizedModelList {...props} key="broad-search" />);
  expect(container.querySelector('.ReactVirtualized__Grid')).toHaveStyle({ width: '420px' });
});
