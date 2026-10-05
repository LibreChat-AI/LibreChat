import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TArtifactApp } from 'librechat-data-provider';
import Thumbnail from './Thumbnail';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const app = {
  artifactAppId: 'app-test',
  title: 'Revenue dashboard',
  activeVersionId: 'version-2',
  preview: {
    type: 'image',
    imageUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    alt: 'Preview of Revenue dashboard',
  },
} as TArtifactApp;

it('renders the stored image without executing the artifact runtime', () => {
  const { container } = render(<Thumbnail app={app} />);
  const image = container.querySelector('img');

  expect(image).toHaveAttribute('src', app.preview?.imageUrl);
  expect(image).toHaveAttribute('alt', '');
  expect(image).toHaveAttribute('loading', 'lazy');
  expect(image).toHaveAttribute('decoding', 'async');
  expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(image).toHaveClass('object-cover', 'object-top');
  expect(container.firstChild).toHaveClass('aspect-[3/2]');
  expect(container.querySelector('iframe')).toBeNull();
});

it('switches to a newly stored preview when the catalog changes', () => {
  const { container, rerender } = render(<Thumbnail app={app} />);
  rerender(
    <Thumbnail
      app={{
        ...app,
        preview: {
          ...app.preview!,
          imageUrl: 'data:image/webp;base64,UklGRgQAAABXRUJQ',
        },
      }}
    />,
  );

  expect(container.querySelector('img')).toHaveAttribute(
    'src',
    'data:image/webp;base64,UklGRgQAAABXRUJQ',
  );
});

it.each([
  'https://attacker.example/pixel.png',
  '//attacker.example/pixel.png',
  'data:image/svg+xml;base64,PHN2Zy8+',
])('uses the fallback instead of loading an unsafe preview: %s', (imageUrl) => {
  const { container } = render(
    <Thumbnail app={{ ...app, preview: { ...app.preview!, imageUrl } }} />,
  );

  expect(screen.getByText('com_ui_artifact_app_preview_unavailable')).toBeInTheDocument();
  expect(container.querySelector('iframe, img')).toBeNull();
});

it('shows a quiet fallback when no stored preview exists', () => {
  const { container } = render(<Thumbnail app={{ ...app, preview: undefined }} />);

  expect(screen.getByText('com_ui_artifact_app_preview_unavailable')).toBeInTheDocument();
  expect(container.querySelector('iframe, img')).toBeNull();
});
