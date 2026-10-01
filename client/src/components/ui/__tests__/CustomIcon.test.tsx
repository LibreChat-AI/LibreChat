import { render, screen, fireEvent } from '@testing-library/react';
import CustomIcon from '../CustomIcon';

describe('CustomIcon', () => {
  it('renders a raster image with its source and accessible label', () => {
    render(<CustomIcon src="/assets/logo.png" alt="My Server" className="size-8" />);

    const img = screen.getByRole('img', { name: 'My Server' });
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', '/assets/logo.png');
  });

  it('hides decorative raster images from assistive technology', () => {
    const { container } = render(<CustomIcon src="/assets/logo.png" alt="" />);

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('aria-hidden', 'true');
    expect(img).toHaveAttribute('src', '/assets/logo.png');
  });

  describe('tinted (masked) rendering', () => {
    it('renders a labeled masked span exposed as an image', () => {
      render(<CustomIcon src="/glyph.svg" alt="My Server" monochrome className="size-8" />);

      const el = screen.getByRole('img', { name: 'My Server' });
      expect(el.tagName).toBe('SPAN');
      expect(el).not.toHaveAttribute('aria-hidden');
      expect(el.style.backgroundColor).toBe('currentcolor');
      expect(el).toHaveClass('custom-icon-tint');
    });

    it('hides a decorative masked span from assistive technology', () => {
      const { container } = render(<CustomIcon src="/glyph.svg" alt="" monochrome />);

      const span = container.querySelector('span');
      expect(span).not.toBeNull();
      expect(span).toHaveAttribute('aria-hidden', 'true');
      expect(span).not.toHaveAttribute('role');
    });

    it('escapes double quotes in the mask URL so the CSS url() stays intact', () => {
      const { container } = render(<CustomIcon src={'/a".svg'} alt="" monochrome />);

      const span = container.querySelector('span');
      expect(span?.style.maskImage).toBe('url("/a%22.svg")');
    });

    it('escapes backslashes and newlines in the mask URL', () => {
      const { container } = render(<CustomIcon src={'/a\\b\nc.svg'} alt="" monochrome />);

      const span = container.querySelector('span');
      expect(span?.style.maskImage).toBe('url("/a%5Cb%0Ac.svg")');
    });

    it('letterboxes with mask-size contain by default', () => {
      const { container } = render(
        <CustomIcon src="/glyph.svg" alt="" monochrome className="size-8" />,
      );

      const span = container.querySelector('span');
      expect(span?.style.maskSize).toBe('contain');
    });

    it('keeps object-cover sizing semantics via mask-size cover', () => {
      const { container } = render(
        <CustomIcon src="/glyph.svg" alt="" monochrome className="h-8 w-8 object-cover" />,
      );

      const span = container.querySelector('span');
      expect(span?.style.maskSize).toBe('cover');
    });

    it('does not render a probe image on the tinted path without an onError handler', () => {
      const { container } = render(<CustomIcon src="/glyph.svg" alt="" monochrome />);

      expect(container.querySelector('span img')).toBeNull();
    });

    it('routes a mask load failure to onError via a hidden probe image', () => {
      const onError = jest.fn();
      const { container } = render(
        <CustomIcon src="/broken.svg" alt="" monochrome onError={onError} />,
      );

      const probe = container.querySelector('span img');
      expect(probe).not.toBeNull();
      fireEvent.error(probe as HTMLImageElement);
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });
});
