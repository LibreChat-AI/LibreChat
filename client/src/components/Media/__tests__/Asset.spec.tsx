import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { MediaAsset } from 'librechat-data-provider';
import { MediaPreview } from '../Asset';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  PixelCard: () => <div data-testid="pixels" />,
}));

const asset: MediaAsset = {
  file_id: 'gemini-image',
  filename: 'original.jpeg',
  filepath: '/images/user/original.jpg',
  type: 'image/jpeg',
  bytes: 100,
  width: 512,
  height: 512,
};

test('loads opened images immediately and recovers a failed preview without another generation', () => {
  const view = render(<MediaPreview asset={asset} />);
  const image = screen.getByRole('img');
  expect(image).toHaveAttribute('loading', 'eager');
  expect(screen.getByText('com_media_preview_loading')).toBeInTheDocument();
  fireEvent.error(image);
  fireEvent.click(screen.getByRole('button', { name: 'com_media_retry_preview' }));
  expect(screen.getByRole('img')).toHaveAttribute('src', '/images/user/original.jpg');
  fireEvent.load(screen.getByRole('img'));
  expect(screen.queryByText('com_media_preview_loading')).not.toBeInTheDocument();
  expect(screen.queryByText('com_media_preview_failed')).not.toBeInTheDocument();
  fireEvent.error(screen.getByRole('img'));
  view.rerender(
    <MediaPreview
      asset={{ ...asset, file_id: 'another-image', filepath: '/images/user/another.jpg' }}
    />,
  );
  expect(screen.getByRole('img')).toHaveAttribute('src', '/images/user/another.jpg');
  expect(screen.queryByText('com_media_preview_failed')).not.toBeInTheDocument();
});

test('a failed gallery thumbnail stays noninteractive inside its parent card', () => {
  render(
    <button type="button">
      <MediaPreview asset={asset} compact />
    </button>,
  );
  expect(screen.getByRole('img')).toHaveAttribute('loading', 'lazy');
  fireEvent.error(screen.getByRole('img'));
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByText('com_media_preview_unavailable')).toBeInTheDocument();
});

test('uses a thumbnail for gallery tiles and falls back to the immutable original on failure', () => {
  const thumbnail = {
    filepath: '/media/thumbnail.webp',
    type: 'image/webp',
    bytes: 40,
    width: 64,
    height: 64,
  };
  const view = render(<MediaPreview asset={{ ...asset, renditions: { thumbnail } }} compact />);
  expect(screen.getByRole('img')).toHaveAttribute('src', thumbnail.filepath);
  expect(screen.getByRole('img')).toHaveAttribute('width', '64');
  fireEvent.error(screen.getByRole('img'));
  expect(screen.getByRole('img')).toHaveAttribute('src', asset.filepath);
  expect(screen.queryByText('com_media_preview_unavailable')).not.toBeInTheDocument();
  fireEvent.load(screen.getByRole('img'));
  expect(screen.queryByText('com_media_preview_loading')).not.toBeInTheDocument();
  view.rerender(<MediaPreview asset={{ ...asset, renditions: { thumbnail } }} expanded />);
  expect(screen.getByRole('img')).toHaveAttribute('src', asset.filepath);
  view.rerender(
    <MediaPreview
      asset={{
        ...asset,
        renditions: { thumbnail: { ...thumbnail, filepath: '/media/recovered.webp' } },
      }}
      compact
    />,
  );
  expect(screen.getByRole('img')).toHaveAttribute('src', '/media/recovered.webp');
});

test('gallery video posters load as images and playback failures fall back to the original', () => {
  const videoAsset = {
    ...asset,
    type: 'video/webm',
    filepath: '/media/original.webm',
    renditions: {
      poster: {
        filepath: '/media/poster.webp',
        type: 'image/webp',
        bytes: 40,
        width: 64,
        height: 36,
      },
      playback: { filepath: '/media/playback.mp4', type: 'video/mp4', bytes: 80 },
    },
  };
  const view = render(<MediaPreview asset={videoAsset} compact />);
  const poster = screen.getByRole('img', { name: 'com_media_video_preview' });
  expect(poster).toHaveAttribute('src', videoAsset.renditions.poster.filepath);
  expect(poster).toHaveAttribute('loading', 'lazy');
  expect(view.container.querySelector('video')).toBeNull();
  fireEvent.load(poster);
  expect(screen.queryByText('com_media_preview_loading')).not.toBeInTheDocument();
  view.rerender(<MediaPreview asset={videoAsset} expanded />);
  const player = screen.getByLabelText('com_media_video_preview');
  expect(player.tagName).toBe('VIDEO');
  expect(player).toHaveAttribute('poster', videoAsset.renditions.poster.filepath);
  expect(player).toHaveAttribute('src', videoAsset.renditions.playback.filepath);
  expect(player).toHaveAttribute('controls');
  fireEvent.error(player);
  expect(player).toHaveAttribute('src', videoAsset.filepath);
  expect(screen.queryByText('com_media_preview_failed')).not.toBeInTheDocument();
  fireEvent.error(player);
  expect(screen.getByText('com_media_preview_failed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_retry_preview' }));
  expect(screen.getByLabelText('com_media_video_preview')).toHaveAttribute(
    'src',
    videoAsset.renditions.playback.filepath,
  );
});

test('an unavailable poster falls back to the existing lazy video preview', () => {
  const view = render(
    <MediaPreview
      asset={{
        ...asset,
        type: 'video/mp4',
        filepath: '/media/original.mp4',
        renditions: { poster: { filepath: '/media/poster.webp', type: 'image/webp', bytes: 40 } },
      }}
      compact
    />,
  );
  fireEvent.error(screen.getByRole('img', { name: 'com_media_video_preview' }));
  expect(view.container.querySelector('video')).not.toBeNull();
  expect(screen.queryByText('com_media_preview_unavailable')).not.toBeInTheDocument();
});

test('gallery videos fetch originals only after entering the viewport and disconnect on unmount', () => {
  const previous = global.IntersectionObserver;
  let intersect: (visible: boolean) => void = () => {
    throw new Error('The preview observer was not created');
  };
  const disconnect = jest.fn();
  global.IntersectionObserver = class implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    constructor(callback: IntersectionObserverCallback) {
      intersect = (isIntersecting) =>
        callback([{ isIntersecting } as IntersectionObserverEntry], this);
    }

    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = disconnect;
    takeRecords = () => [];
  };
  try {
    const view = render(
      <MediaPreview asset={{ ...asset, type: 'video/mp4', filepath: '/media/clip.mp4' }} compact />,
    );
    const player = screen.getByLabelText('com_media_video_preview');
    expect(player).not.toHaveAttribute('src');
    expect(player).toHaveAttribute('preload', 'none');
    act(() => intersect(false));
    expect(player).not.toHaveAttribute('src');
    act(() => intersect(true));
    expect(player).toHaveAttribute('src', '/media/clip.mp4');
    expect(player).toHaveAttribute('preload', 'metadata');
    fireEvent.loadedMetadata(player);
    expect(screen.queryByText('com_media_preview_loading')).not.toBeInTheDocument();
    expect(disconnect).toHaveBeenCalled();
    view.rerender(
      <MediaPreview
        asset={{ ...asset, type: 'video/mp4', filepath: '/media/another.mp4' }}
        compact
      />,
    );
    expect(screen.getByLabelText('com_media_video_preview')).not.toHaveAttribute('src');
    disconnect.mockClear();
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    global.IntersectionObserver = previous;
  }
});

test('audio references use an audio player and clear loading when metadata arrives', () => {
  render(
    <MediaPreview
      asset={{ ...asset, type: 'audio/mpeg', filepath: '/media/voice.mp3' }}
      compact
      interactive
    />,
  );
  const player = screen.getByLabelText('com_media_audio_preview');
  expect(player.tagName).toBe('AUDIO');
  expect(player).toHaveAttribute('controls');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  fireEvent.loadedMetadata(player);
  expect(screen.queryByText('com_media_preview_loading')).not.toBeInTheDocument();
});

test('video reference previews expose playback controls independently of compact thumbnails', () => {
  render(
    <MediaPreview
      asset={{ ...asset, type: 'video/mp4', filepath: '/media/clip.mp4' }}
      compact
      interactive
    />,
  );
  const player = screen.getByLabelText('com_media_video_preview');
  expect(player.tagName).toBe('VIDEO');
  expect(player).toHaveAttribute('controls');
  fireEvent.loadedMetadata(player);
  expect(screen.queryByText('com_media_preview_loading')).not.toBeInTheDocument();
});

test('a generated image retains pixels through loading and preview retry without regenerating', () => {
  render(
    <MediaPreview
      asset={{ ...asset, width: 768, height: 1024 }}
      imagePendingSince="2026-09-17T12:00:00Z"
    />,
  );
  const image = screen.getByRole('img');
  expect(screen.getByTestId('pixels')).toBeInTheDocument();
  expect(image).toHaveClass(
    'object-contain',
    'transition-opacity',
    'opacity-0',
    'motion-reduce:transition-none',
  );
  expect(image.parentElement).toHaveClass('aspect-(--media-ratio)', 'w-full');
  expect(image.parentElement?.style.getPropertyValue('--media-ratio')).toBe('0.75');
  expect(image.parentElement).toHaveStyle({ maxWidth: '384px' });
  fireEvent.error(image);
  expect(screen.queryByTestId('pixels')).not.toBeInTheDocument();
  expect(screen.getByText('com_media_preview_failed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_retry_preview' }));
  expect(screen.getByTestId('pixels')).toBeInTheDocument();
  fireEvent.load(screen.getByRole('img'));
  expect(screen.queryByTestId('pixels')).not.toBeInTheDocument();
  expect(screen.getByRole('img')).toHaveClass('opacity-100');
});

test.each(['compact', 'expanded'] as const)(
  'generated image %s views keep their existing loading behavior',
  (mode) => {
    render(
      <MediaPreview asset={asset} imagePendingSince="2026-09-17T12:00:00Z" {...{ [mode]: true }} />,
    );
    expect(screen.queryByTestId('pixels')).not.toBeInTheDocument();
    expect(screen.getByText('com_media_preview_loading')).toBeInTheDocument();
  },
);
