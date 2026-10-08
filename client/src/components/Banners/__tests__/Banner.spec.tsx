import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import type { TBanner } from 'librechat-data-provider';
import { Banner } from '../Banner';

jest.mock('~/data-provider', () => ({
  useGetBannerQuery: jest.fn(),
}));
const mockUseGetBannerQuery = jest.requireMock('~/data-provider').useGetBannerQuery as jest.Mock;

const baseBanner: TBanner = {
  bannerId: 'banner-1',
  message: 'Take the <a href="https://example.com">survey</a>',
  displayFrom: '2026-10-01T00:00:00.000Z',
  displayTo: '2026-10-31T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  isPublic: false,
  persistable: true,
};

const renderBanner = (banner: TBanner) => {
  mockUseGetBannerQuery.mockReturnValue({ data: banner });
  const { container } = render(
    <RecoilRoot>
      <Banner />
    </RecoilRoot>,
  );
  return {
    bar: container.firstElementChild as HTMLElement,
    message: screen.getByText(/Take the/),
  };
};

describe('Banner', () => {
  it('keeps the default presentation when no variant is set', () => {
    const { bar, message } = renderBanner(baseBanner);
    expect(bar).toHaveClass('bg-presentation', 'text-text-primary');
    expect(bar).not.toHaveClass('border-b');
    expect(message).toHaveClass('[&_a]:text-link');
  });

  it('applies the variant status colors and lets links inherit them', () => {
    const { bar, message } = renderBanner({ ...baseBanner, variant: 'warning' });
    expect(bar).toHaveClass(
      'border-b',
      'border-status-warning-border',
      'bg-status-warning-subtle',
      'text-status-warning',
    );
    expect(bar).not.toHaveClass('bg-presentation');
    expect(message).toHaveClass('[&_a]:text-inherit');
    expect(message).not.toHaveClass('[&_a]:text-link');
  });

  it('uses the alert error roles for the error variant', () => {
    const { bar } = renderBanner({ ...baseBanner, variant: 'error' });
    expect(bar).toHaveClass(
      'border-alert-error-border',
      'bg-alert-error-fill',
      'text-status-error',
    );
  });
});
