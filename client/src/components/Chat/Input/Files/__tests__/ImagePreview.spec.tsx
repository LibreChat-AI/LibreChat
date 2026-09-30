import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ImagePreview from '../ImagePreview';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, options?: { 0?: string | number; 1?: string | number }): string =>
      [key, options?.[0], options?.[1]].filter((value) => value !== undefined).join(':'),
}));

/**
 * The expand affordance is decorative (aria-hidden), so it is asserted through the
 * opacity utilities that actually drive its visibility.
 */
const getAffordance = (container: HTMLElement) =>
  container.querySelector('[aria-hidden="true"]') as HTMLElement;

describe('ImagePreview', () => {
  const trigger = () =>
    screen.getByRole('button', {
      name: 'com_ui_view_image_full_size:com_ui_image_preview',
    });

  test('describes upload progress through the image control', () => {
    render(<ImagePreview url="/img.png" alt="quarterly chart" progress={0.42} />);

    const imageButton = screen.getByRole('button', {
      name: 'com_ui_view_image_full_size_uploading:quarterly chart:42',
    });

    expect(imageButton).toHaveAttribute('aria-busy', 'true');
  });

  test('names the preview dialog and restores focus when it closes', async () => {
    render(<ImagePreview url="/img.png" alt="quarterly chart" />);

    const imageButton = screen.getByRole('button', {
      name: 'com_ui_view_image_full_size:quarterly chart',
    });
    fireEvent.click(imageButton);

    expect(
      screen.getByRole('dialog', { name: 'com_ui_image_preview_var:quarterly chart' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_close' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(imageButton).toHaveFocus());
  });

  test('is hidden at rest', () => {
    const { container } = render(<ImagePreview url="/img.png" />);

    expect(getAffordance(container)).toHaveClass('opacity-0');
  });

  test('appears on hover', () => {
    const { container } = render(<ImagePreview url="/img.png" />);

    fireEvent.mouseEnter(trigger());

    expect(getAffordance(container)).toHaveClass('opacity-100');
  });

  test('appears on keyboard focus', () => {
    const { container } = render(<ImagePreview url="/img.png" />);

    fireEvent.focus(trigger());

    expect(getAffordance(container)).toHaveClass('opacity-100');
  });

  test('hides again on blur', () => {
    const { container } = render(<ImagePreview url="/img.png" />);

    fireEvent.focus(trigger());
    fireEvent.blur(trigger());

    expect(getAffordance(container)).toHaveClass('opacity-0');
  });

  test('stays visible while focused after the pointer leaves', () => {
    const { container } = render(<ImagePreview url="/img.png" />);

    fireEvent.focus(trigger());
    fireEvent.mouseEnter(trigger());
    fireEvent.mouseLeave(trigger());

    expect(getAffordance(container)).toHaveClass('opacity-100');
  });

  test('keeps a visible focus ring on the trigger', () => {
    render(<ImagePreview url="/img.png" />);

    expect(trigger()).toHaveClass('focus-visible:ring-2');
  });
});
