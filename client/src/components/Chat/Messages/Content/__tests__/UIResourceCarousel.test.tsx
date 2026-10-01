import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UIResource } from 'librechat-data-provider';
import type { ComponentProps } from 'react';
import UIResourceCarousel from '~/components/Chat/Messages/Content/UIResourceCarousel';
import { handleUIAction } from '~/utils';

jest.mock(
  '@librechat/client',
  () => ({
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<'button'> & { variant?: string; size?: string }) => <button {...props} />,
  }),
  { virtual: true },
);

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    key === 'com_ui_scroll_left' ? 'Scroll left' : 'Scroll right',
}));

jest.mock('~/Providers/MCPAppsPolicyContext', () => ({
  useMCPAppsPolicy: () => ({ enabled: true, legacyHtmlEnabled: true }),
}));

// Mock the UIResourceRenderer component
jest.mock('@mcp-ui/client', () => ({
  UIResourceRenderer: ({ resource, onUIAction }: any) => (
    <div data-testid="ui-resource-renderer" onClick={() => onUIAction({ action: 'test' })}>
      {resource.text || 'UI Resource'}
    </div>
  ),
}));

// Mock useOptionalMessagesOperations hook
const mockAsk = jest.fn();
jest.mock('~/Providers', () => ({
  useOptionalMessagesOperations: () => ({
    ask: mockAsk,
  }),
}));

// Mock handleUIAction utility
jest.mock('~/utils', () => ({
  handleUIAction: jest.fn(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Mock scrollTo
const mockScrollTo = jest.fn();
Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  value: mockScrollTo,
});

describe('UIResourceCarousel', () => {
  const mockUIResources: UIResource[] = [
    { resourceId: 'resource1', uri: 'resource1', mimeType: 'text/html', text: 'Resource 1' },
    { resourceId: 'resource2', uri: 'resource2', mimeType: 'text/html', text: 'Resource 2' },
    { resourceId: 'resource3', uri: 'resource3', mimeType: 'text/html', text: 'Resource 3' },
    { resourceId: 'resource4', uri: 'resource4', mimeType: 'text/html', text: 'Resource 4' },
    { resourceId: 'resource5', uri: 'resource5', mimeType: 'text/html', text: 'Resource 5' },
  ];

  const mockHandleUIAction = handleUIAction as jest.MockedFunction<typeof handleUIAction>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAsk.mockClear();
    mockHandleUIAction.mockClear();
    // Reset scroll properties
    Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      value: 500,
    });
  });

  it('renders nothing when no resources provided', () => {
    const { container } = render(<UIResourceCarousel uiResources={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('filters blocked resources before choosing a single-resource layout', () => {
    const { container } = render(
      <UIResourceCarousel
        uiResources={[
          {
            resourceId: 'blocked-resource',
            uri: 'ui://blocked',
            mimeType: 'application/vnd.mcp-ui.remote-dom+javascript',
            text: 'malicious script',
          },
          mockUIResources[0],
        ]}
      />,
    );

    expect(screen.getAllByTestId('ui-resource-renderer')).toHaveLength(1);
    expect(screen.getByText('Resource 1')).toBeInTheDocument();
    expect(container.querySelector('.hide-scrollbar')).not.toBeInTheDocument();
  });

  it('renders nothing when every resource is blocked', () => {
    const { container } = render(
      <UIResourceCarousel
        uiResources={[
          {
            resourceId: 'blocked-resource',
            uri: 'ui://blocked',
            mimeType: 'text/uri-list',
            text: 'https://example.com',
          },
        ]}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders all UI resources', () => {
    render(<UIResourceCarousel uiResources={mockUIResources} />);
    const renderers = screen.getAllByTestId('ui-resource-renderer');
    expect(renderers).toHaveLength(5);
    expect(screen.getByText('Resource 1')).toBeInTheDocument();
    expect(screen.getByText('Resource 5')).toBeInTheDocument();
  });

  it('shows/hides navigation arrows on hover', async () => {
    const { container } = render(<UIResourceCarousel uiResources={mockUIResources} />);
    const carouselContainer = container.querySelector('.relative.mb-4.pt-3');

    // Initially arrows should be hidden (opacity-0)
    const leftArrow = screen.queryByLabelText('Scroll left');
    const rightArrow = screen.queryByLabelText('Scroll right');

    // Right arrow should exist but left should not (at start)
    expect(leftArrow).not.toBeInTheDocument();
    expect(rightArrow).toBeInTheDocument();
    expect(rightArrow).toHaveClass('opacity-0');

    // Hover over container
    fireEvent.mouseEnter(carouselContainer!);
    await waitFor(() => {
      expect(rightArrow).toHaveClass('opacity-100');
    });

    // Leave hover
    fireEvent.mouseLeave(carouselContainer!);
    await waitFor(() => {
      expect(rightArrow).toHaveClass('opacity-0');
    });
  });

  it('handles scroll navigation', async () => {
    const { container } = render(<UIResourceCarousel uiResources={mockUIResources} />);
    const scrollContainer = container.querySelector('.hide-scrollbar');

    // Simulate being scrolled to show left arrow
    Object.defineProperty(scrollContainer, 'scrollLeft', {
      configurable: true,
      value: 200,
    });

    // Trigger scroll event
    fireEvent.scroll(scrollContainer!);

    // Both arrows should now be visible
    await waitFor(() => {
      expect(screen.getByLabelText('Scroll left')).toBeInTheDocument();
      expect(screen.getByLabelText('Scroll right')).toBeInTheDocument();
    });

    // Hover to make arrows interactive
    const carouselContainer = container.querySelector('.relative.mb-4.pt-3');
    fireEvent.mouseEnter(carouselContainer!);

    // Click right arrow
    fireEvent.click(screen.getByLabelText('Scroll right'));
    expect(mockScrollTo).toHaveBeenCalledWith({
      left: 650, // 200 + (500 * 0.9)
      behavior: 'smooth',
    });

    // Click left arrow
    fireEvent.click(screen.getByLabelText('Scroll left'));
    expect(mockScrollTo).toHaveBeenCalledWith({
      left: -250, // 200 - (500 * 0.9)
      behavior: 'smooth',
    });
  });

  it('binds scrolling when a singleton becomes a carousel', async () => {
    const { container, rerender } = render(
      <UIResourceCarousel uiResources={mockUIResources.slice(0, 1)} />,
    );
    expect(container.querySelector('.hide-scrollbar')).not.toBeInTheDocument();

    rerender(<UIResourceCarousel uiResources={mockUIResources.slice(0, 2)} />);
    const scrollContainer = container.querySelector('.hide-scrollbar');
    Object.defineProperty(scrollContainer, 'scrollLeft', {
      configurable: true,
      value: 200,
    });

    fireEvent.scroll(scrollContainer!);

    await waitFor(() => {
      expect(screen.getByLabelText('Scroll left')).toBeInTheDocument();
    });
  });

  it('hides right arrow when scrolled to end', async () => {
    const { container } = render(<UIResourceCarousel uiResources={mockUIResources} />);
    const scrollContainer = container.querySelector('.hide-scrollbar');

    // Simulate scrolled to end
    Object.defineProperty(scrollContainer, 'scrollLeft', {
      configurable: true,
      value: 490, // scrollWidth - clientWidth - 10
    });

    fireEvent.scroll(scrollContainer!);

    await waitFor(() => {
      expect(screen.getByLabelText('Scroll left')).toBeInTheDocument();
      expect(screen.queryByLabelText('Scroll right')).not.toBeInTheDocument();
    });
  });

  it('handles UIResource actions using handleUIAction', async () => {
    render(<UIResourceCarousel uiResources={mockUIResources.slice(0, 1)} />);

    const renderer = screen.getByTestId('ui-resource-renderer');
    fireEvent.click(renderer);

    await waitFor(() => {
      expect(mockHandleUIAction).toHaveBeenCalledWith({ action: 'test' }, mockAsk);
    });
  });

  it('calls handleUIAction with correct parameters for multiple resources', async () => {
    render(<UIResourceCarousel uiResources={mockUIResources.slice(0, 3)} />);

    const renderers = screen.getAllByTestId('ui-resource-renderer');

    // Click the second renderer
    fireEvent.click(renderers[1]);

    await waitFor(() => {
      expect(mockHandleUIAction).toHaveBeenCalledWith({ action: 'test' }, mockAsk);
      expect(mockHandleUIAction).toHaveBeenCalledTimes(1);
    });

    // Click the third renderer
    fireEvent.click(renderers[2]);

    await waitFor(() => {
      expect(mockHandleUIAction).toHaveBeenCalledTimes(2);
    });
  });

  it('passes correct ask function to handleUIAction', async () => {
    render(<UIResourceCarousel uiResources={mockUIResources.slice(0, 1)} />);

    const renderer = screen.getByTestId('ui-resource-renderer');
    fireEvent.click(renderer);

    await waitFor(() => {
      expect(mockHandleUIAction).toHaveBeenCalledWith({ action: 'test' }, mockAsk);
      expect(mockHandleUIAction).toHaveBeenCalledTimes(1);
    });
  });

  it('applies correct dimensions to resource containers', () => {
    render(<UIResourceCarousel uiResources={mockUIResources.slice(0, 2)} />);
    const containers = screen
      .getAllByTestId('ui-resource-renderer')
      .map((el) => el.parentElement?.parentElement);

    containers.forEach((container, index) => {
      expect(container).toHaveStyle({
        width: '230px',
        minHeight: '360px',
        animationDelay: `${index * 100}ms`,
      });
    });
  });

  it('shows correct gradient overlays based on scroll position', () => {
    const { container } = render(<UIResourceCarousel uiResources={mockUIResources} />);

    // At start, left gradient should be hidden, right should be visible
    const leftGradient = container.querySelector('.bg-gradient-to-r');
    const rightGradient = container.querySelector('.bg-gradient-to-l');

    expect(leftGradient).toHaveClass('opacity-0');
    expect(rightGradient).toHaveClass('opacity-100');
  });

  it('cleans up event listeners on unmount', () => {
    const { container, unmount } = render(<UIResourceCarousel uiResources={mockUIResources} />);
    const scrollContainer = container.querySelector('.hide-scrollbar');

    const removeEventListenerSpy = jest.spyOn(scrollContainer!, 'removeEventListener');

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('renders with animation delays for each resource', () => {
    render(<UIResourceCarousel uiResources={mockUIResources.slice(0, 3)} />);
    const resourceContainers = screen
      .getAllByTestId('ui-resource-renderer')
      .map((el) => el.parentElement?.parentElement);

    resourceContainers.forEach((container, index) => {
      expect(container).toHaveStyle({
        animationDelay: `${index * 100}ms`,
      });
    });
  });

  it('memoizes component properly', () => {
    const { rerender } = render(<UIResourceCarousel uiResources={mockUIResources} />);
    const firstRender = screen.getAllByTestId('ui-resource-renderer');

    // Re-render with same props
    rerender(<UIResourceCarousel uiResources={mockUIResources} />);
    const secondRender = screen.getAllByTestId('ui-resource-renderer');

    // Component should not re-render with same props (React.memo)
    expect(firstRender.length).toBe(secondRender.length);
  });
});
