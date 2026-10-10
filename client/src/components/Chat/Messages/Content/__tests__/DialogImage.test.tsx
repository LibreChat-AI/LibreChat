import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DialogImage from '../DialogImage';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual<typeof import('@librechat/client')>('@librechat/client');
  return {
    ...actual,
    useRemScale: () => 1,
    useMediaQuery: () => false,
  };
});

/** The lightbox is a raw Radix dialog at z-250, not an OGDialog, so a tooltip left on the
 *  stylesheet default (150) would paint behind its overlay. */
const LIGHTBOX_Z_INDEX = 250;

describe('DialogImage tooltips', () => {
  it('layers the close tooltip above the lightbox', async () => {
    render(
      <DialogImage isOpen onOpenChange={jest.fn()} src="/media.png" downloadImage={jest.fn()} />,
    );

    const close = screen.getByRole('button', { name: 'com_ui_close' });
    fireEvent.mouseEnter(close);
    fireEvent.mouseMove(close);

    const tooltip = await screen.findByRole('tooltip', undefined, { timeout: 3000 });
    expect(Number(tooltip.style.zIndex)).toBeGreaterThan(LIGHTBOX_Z_INDEX);
  });

  it('layers the download tooltip above the lightbox', async () => {
    render(
      <DialogImage isOpen onOpenChange={jest.fn()} src="/media.png" downloadImage={jest.fn()} />,
    );

    const download = screen.getByRole('button', { name: 'com_ui_download' });
    fireEvent.mouseEnter(download);
    fireEvent.mouseMove(download);

    const tooltip = await screen.findByRole('tooltip', undefined, { timeout: 3000 });
    expect(Number(tooltip.style.zIndex)).toBeGreaterThan(LIGHTBOX_Z_INDEX);
  });
});
