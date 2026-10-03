import { render, cleanup, waitFor } from '@testing-library/react';
import PixelCard from './PixelCard';

/** The canvas draws with whatever the palette resolved to, so the test reads what the card
 *  asked the page for: which theme variables, and whether it asks again after a theme change. */
describe('PixelCard palette', () => {
  let fillStyles: string[];
  let channels: Record<string, string>;

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
    channels = {
      '--surface-primary-alt': '1 2 3',
      '--surface-tertiary': '1 2 3',
      '--border-medium': '1 2 3',
    };
    const computed = window.getComputedStyle.bind(window);
    jest.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = computed(element);
      return {
        ...style,
        getPropertyValue: (name: string) =>
          name.startsWith('--') ? (channels[name] ?? '') : style.getPropertyValue(name),
      } as CSSStyleDeclaration;
    });
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    document.documentElement.className = '';
  });

  it('draws the default variant from theme variables', async () => {
    render(<PixelCard progress={1} />);

    await waitFor(() => expect(fillStyles).toContain('rgb(1 2 3)'));
    expect(fillStyles.every((style) => style === 'rgb(1 2 3)')).toBe(true);
  });

  it('draws each default slot from its own theme variable, and currentColor when one is unset', async () => {
    channels = { '--surface-primary-alt': '1 1 1', '--surface-tertiary': '2 2 2' };
    jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 200, height: 200 } as DOMRect);
    let sample = 0;
    jest.spyOn(Math, 'random').mockImplementation(() => ((sample++ % 3) + 0.5) / 3);
    render(<PixelCard progress={1} />);

    await waitFor(() =>
      expect(new Set(fillStyles)).toEqual(new Set(['rgb(1 1 1)', 'rgb(2 2 2)', 'currentColor'])),
    );
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
    channels = {
      '--surface-primary-alt': '9 9 9',
      '--surface-tertiary': '9 9 9',
      '--border-medium': '9 9 9',
    };
    document.documentElement.classList.add('dark');

    await waitFor(() => expect(fillStyles).toContain('rgb(9 9 9)'));
  });

  it('keeps its pixels when an unrelated root variable changes', async () => {
    render(<PixelCard progress={1} />);
    await waitFor(() => expect(fillStyles).toContain('rgb(1 2 3)'));
    const measure = HTMLElement.prototype.getBoundingClientRect as jest.Mock;
    const layouts = measure.mock.calls.length;

    document.documentElement.style.setProperty('--message-scrollbar-gutter', '8px');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(measure.mock.calls.length).toBe(layouts);
    document.documentElement.style.removeProperty('--message-scrollbar-gutter');
  });
});
