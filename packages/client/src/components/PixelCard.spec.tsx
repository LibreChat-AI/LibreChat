import { render, waitFor } from '@testing-library/react';
import PixelCard from './PixelCard';

/** The canvas draws with whatever the palette resolved to, so the test reads what the card
 *  asked the page for: which theme variables, and whether it asks again after a theme change. */
describe('PixelCard palette', () => {
  let fillStyles: string[];
  let channels: string;

  beforeEach(() => {
    fillStyles = [];
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      return {
        clearRect: jest.fn(),
        fillRect: jest.fn(),
        set fillStyle(value: string) {
          fillStyles.push(value);
        },
      } as unknown as CanvasRenderingContext2D;
    });
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 10,
      height: 10,
    } as DOMRect);
    channels = '1 2 3';
    const computed = window.getComputedStyle.bind(window);
    jest.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = computed(element);
      return {
        ...style,
        getPropertyValue: (name: string) =>
          name.startsWith('--') ? channels : style.getPropertyValue(name),
      } as CSSStyleDeclaration;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.documentElement.className = '';
  });

  it('draws the default variant from theme variables', async () => {
    render(<PixelCard progress={1} />);

    await waitFor(() => expect(fillStyles).toContain('rgb(1 2 3)'));
    expect(fillStyles.every((style) => style === 'rgb(1 2 3)')).toBe(true);
  });

  it('keeps an explicit colors prop as given', async () => {
    render(<PixelCard progress={1} colors="#123456" />);

    await waitFor(() => expect(fillStyles).toContain('#123456'));
    expect(fillStyles.every((style) => style === '#123456')).toBe(true);
  });

  it('re-reads the palette when the theme changes', async () => {
    render(<PixelCard progress={1} />);
    await waitFor(() => expect(fillStyles).toContain('rgb(1 2 3)'));

    fillStyles = [];
    channels = '9 9 9';
    document.documentElement.classList.add('dark');

    await waitFor(() => expect(fillStyles).toContain('rgb(9 9 9)'));
  });
});
