import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Image, { _resetImageCaches } from '../Image';

jest.mock('~/utils', () => ({
  cn: (...classes: (string | boolean | undefined | null)[]) =>
    classes
      .flat(Infinity)
      .filter((c): c is string => typeof c === 'string' && c.length > 0)
      .join(' '),
  /** Real implementation: URL resolution is what the cases below assert. */
  toAbsoluteFilePath:
    jest.requireActual<typeof import('~/utils/media')>('~/utils/media').toAbsoluteFilePath,
}));

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
}));

jest.mock('@librechat/client', () => ({
  Skeleton: ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="skeleton" className={className} {...props} />
  ),
}));

jest.mock('../DialogImage', () => ({
  __esModule: true,
  default: ({ isOpen, src }: { isOpen: boolean; src: string }) =>
    isOpen ? <div data-testid="dialog-image" data-src={src} /> : null,
}));

describe('Image', () => {
  const defaultProps = {
    imagePath: '/images/test.png',
    altText: 'Test image',
  };

  beforeEach(() => {
    _resetImageCaches();
    jest.clearAllMocks();
  });

  describe('rendering without dimensions', () => {
    it('renders with max-h-[45vh] height constraint', () => {
      render(<Image {...defaultProps} />);
      const img = screen.getByRole('img');
      expect(img.className).toContain('max-h-[45vh]');
    });

    it('renders with max-w-full to prevent landscape clipping', () => {
      render(<Image {...defaultProps} />);
      const img = screen.getByRole('img');
      expect(img.className).toContain('max-w-full');
    });

    it('renders with w-auto and h-auto for natural aspect ratio', () => {
      render(<Image {...defaultProps} />);
      const img = screen.getByRole('img');
      expect(img.className).toContain('w-auto');
      expect(img.className).toContain('h-auto');
    });

    it('does not show skeleton without dimensions', () => {
      render(<Image {...defaultProps} />);
      expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
    });

    it('does not apply heightStyle without dimensions', () => {
      render(<Image {...defaultProps} />);
      const button = screen.getByRole('button');
      expect(button.style.height).toBeFalsy();
    });
  });

  describe('rendering with dimensions', () => {
    it('shows skeleton behind image', () => {
      render(<Image {...defaultProps} width={1024} height={1792} />);
      expect(screen.getByTestId('skeleton')).toBeInTheDocument();
    });

    it('applies computed heightStyle to button', () => {
      render(<Image {...defaultProps} width={1024} height={1792} />);
      const button = screen.getByRole('button');
      expect(button.style.height).toBeTruthy();
      expect(button.style.height).toContain('min(45vh');
    });

    it('uses size-full object-contain on image when dimensions provided', () => {
      render(<Image {...defaultProps} width={768} height={916} />);
      const img = screen.getByRole('img');
      expect(img.className).toContain('size-full');
      expect(img.className).toContain('object-contain');
    });

    it('skeleton is absolute inset-0', () => {
      render(<Image {...defaultProps} width={512} height={512} />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton.className).toContain('absolute');
      expect(skeleton.className).toContain('inset-0');
    });

    it('marks URL as painted on load and skips skeleton on rerender', () => {
      const { rerender } = render(<Image {...defaultProps} width={512} height={512} />);
      const img = screen.getByRole('img');

      expect(screen.getByTestId('skeleton')).toBeInTheDocument();

      fireEvent.load(img);

      // Rerender same component — skeleton should not show (URL painted)
      rerender(<Image {...defaultProps} width={512} height={512} />);
      expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
    });
  });

  describe('common behavior', () => {
    it('aligns only explicitly marked images to the right', () => {
      const { rerender } = render(<Image {...defaultProps} />);
      const wrapper = screen.getByRole('button').parentElement;
      expect(wrapper).not.toHaveClass('ml-auto');

      rerender(<Image {...defaultProps} alignRight />);
      expect(wrapper).toHaveClass('ml-auto');
    });

    it('applies custom className to the button wrapper', () => {
      render(<Image {...defaultProps} className="mb-4" />);
      const button = screen.getByRole('button');
      expect(button.className).toContain('mb-4');
    });

    it('sets correct alt text', () => {
      render(<Image {...defaultProps} />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('alt', 'Test image');
    });

    it('has correct accessibility attributes on button', () => {
      render(<Image {...defaultProps} />);
      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-label', 'View Test image in dialog');
      expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    });
  });

  describe('dialog interaction', () => {
    it('opens dialog on button click', () => {
      render(<Image {...defaultProps} />);
      expect(screen.queryByTestId('dialog-image')).not.toBeInTheDocument();

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(screen.getByTestId('dialog-image')).toBeInTheDocument();
    });

    it('dialog is always mounted (not gated by load state)', () => {
      render(<Image {...defaultProps} />);
      // DialogImage mock returns null when isOpen=false, but the component is in the tree
      // Clicking should immediately show it
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByTestId('dialog-image')).toBeInTheDocument();
    });
  });

  describe('image URL resolution', () => {
    it('passes /images/ paths through with base URL', () => {
      render(<Image {...defaultProps} imagePath="/images/test.png" />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', '/images/test.png');
    });

    it('passes absolute http URLs through unchanged', () => {
      render(<Image {...defaultProps} imagePath="https://example.com/photo.jpg" />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', 'https://example.com/photo.jpg');
    });

    it('passes data URIs through unchanged', () => {
      render(<Image {...defaultProps} imagePath="data:image/png;base64,abc" />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', 'data:image/png;base64,abc');
    });

    it('passes non-/images/ paths through unchanged', () => {
      render(<Image {...defaultProps} imagePath="/other/path.png" />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', '/other/path.png');
    });
  });
});
