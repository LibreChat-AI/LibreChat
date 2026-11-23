import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, cleanup } from '@testing-library/react';

let mockShowMarketplace = true;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useShowMarketplace: () => mockShowMarketplace,
}));

jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    asChild: _asChild,
    ...props
  }: React.ComponentProps<'button'> & { asChild?: boolean }) => (
    <button {...props}>{children}</button>
  ),
  TooltipAnchor: ({ render: trigger }: { render: React.ReactNode }) => trigger,
}));

import AgentMarketplaceButton from '../AgentMarketplaceButton';

const renderButton = (layout?: 'icon' | 'row') =>
  render(<AgentMarketplaceButton layout={layout} />, { wrapper: MemoryRouter });

describe('AgentMarketplaceButton', () => {
  afterEach(() => {
    mockShowMarketplace = true;
    cleanup();
  });

  it('routes to the marketplace', () => {
    renderButton();

    expect(screen.getByTestId('nav-agents-marketplace-button')).toHaveAttribute('href', '/agents');
  });

  /** The drawer is the only sidebar surface on small screens, so this row is the
   *  one route to `/agents` there. */
  it('shows its own label as a row, and leans on the tooltip as an icon', () => {
    renderButton('row');
    expect(screen.getByText('com_agents_marketplace')).toBeInTheDocument();
    expect(screen.getByTestId('nav-agents-marketplace-button')).not.toHaveAttribute('aria-label');

    cleanup();

    renderButton('icon');
    expect(screen.queryByText('com_agents_marketplace')).not.toBeInTheDocument();
    expect(screen.getByTestId('nav-agents-marketplace-button')).toHaveAttribute(
      'aria-label',
      'com_agents_marketplace',
    );
  });

  /** A deployment without marketplace access is left with no gap, in either layout. */
  it('omits itself without marketplace access', () => {
    mockShowMarketplace = false;

    for (const layout of ['icon', 'row'] as const) {
      const { container } = renderButton(layout);
      expect(container).toBeEmptyDOMElement();
      cleanup();
    }
  });
});
