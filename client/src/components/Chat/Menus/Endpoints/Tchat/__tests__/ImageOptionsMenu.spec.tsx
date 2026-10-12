import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import type { TImageSpec } from 'librechat-data-provider';
import { IMAGE_CHOICES_KEY } from '../imageOptions';
import ImageOptionsMenu from '../ImageOptionsMenu';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const gemini: TImageSpec = {
  name: 'gemini',
  label: 'Gemini',
  model: 'gemini-3-pro-image',
  protocol: 'gemini',
  options: { aspectRatios: ['1:1', '16:9'], imageSizes: ['1K', '4K'] },
};

const stored = () => JSON.parse(localStorage.getItem(IMAGE_CHOICES_KEY) ?? '{}');

describe('ImageOptionsMenu', () => {
  beforeEach(() => localStorage.clear());

  it('offers one Auto-first group per honoured parameter and pins a pick', async () => {
    const user = userEvent.setup();
    render(<ImageOptionsMenu spec={gemini} />);
    await user.click(screen.getByTestId('image-options-button'));

    expect(screen.getByText('com_ui_aspect_ratio')).toBeInTheDocument();
    expect(screen.getByText('com_ui_resolution')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_size')).not.toBeInTheDocument();
    expect(screen.getAllByRole('menuitemradio', { name: 'com_ui_auto' })).toHaveLength(2);

    await user.click(screen.getByRole('menuitemradio', { name: '16:9' }));
    await user.click(screen.getByRole('menuitemradio', { name: '4K' }));
    expect(stored()).toEqual({ gemini: { aspectRatio: '16:9', imageSize: '4K' } });
    expect(screen.getByTestId('image-options-button')).toHaveAccessibleName(
      'com_ui_image_options: 16:9 · 4K',
    );

    const autos = screen.getAllByRole('menuitemradio', { name: 'com_ui_auto' });
    await user.click(autos[0]);
    await user.click(autos[1]);
    expect(stored()).toEqual({});
  });
});
