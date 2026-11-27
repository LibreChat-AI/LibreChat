import {
  applyMermaidBackground,
  processMermaidSvg,
  resolveCanvasDimensions,
  downloadMermaidPng,
  downloadMermaidSvg,
} from './export';
import { triggerDownload } from '~/utils/downloadFile';

jest.mock('~/utils/downloadFile', () => ({
  triggerDownload: jest.fn(),
}));

const mockTriggerDownload = jest.mocked(triggerDownload);

describe('Mermaid export', () => {
  let createObjectURL: jest.Mock;

  beforeEach(() => {
    createObjectURL = jest.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    mockTriggerDownload.mockReset();
  });

  it('normalizes Mermaid SVG markup for display and export', () => {
    const result = processMermaidSvg('<svg width="400" height="200"><path /></svg>');

    expect(result.dimensions).toEqual({ width: 400, height: 200 });
    expect(result.svg).toContain('viewBox="0 0 400 200"');
    expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(result.svg).not.toContain('width="400"');
    expect(result.svg).not.toContain('height="200"');
  });

  it('uses the viewBox when Mermaid emits responsive percentage dimensions', () => {
    const result = processMermaidSvg(
      '<svg width="100%" height="100%" viewBox="-8 -8 416 216"><path /></svg>',
    );

    expect(result.dimensions).toEqual({ width: 416, height: 216 });
  });

  it('rounds rectangular Mermaid nodes without changing cluster containers', () => {
    const result = processMermaidSvg(
      '<svg viewBox="0 0 200 100"><g class="node default"><rect width="80" height="40" /></g><g class="cluster"><rect width="180" height="80" /></g></svg>',
    );
    const document = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
    const nodeRectangle = document.querySelector('g.node rect');
    const clusterRectangle = document.querySelector('g.cluster rect');

    expect(nodeRectangle?.getAttribute('rx')).toBe('8');
    expect(nodeRectangle?.getAttribute('ry')).toBe('8');
    expect(clusterRectangle?.hasAttribute('rx')).toBe(false);
  });

  it('embeds the active surface behind an exported SVG', () => {
    const svg = applyMermaidBackground(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 416 216"><path /></svg>',
      'rgb(23 23 23)',
    );

    expect(svg).toContain('<rect x="-8" y="-8" width="416" height="216" fill="rgb(23 23 23)"');
  });

  it('caps PNG canvas allocations to 16 megapixels', () => {
    expect(resolveCanvasDimensions(10_000, 10_000)).toEqual({ width: 4096, height: 4096 });
  });

  it('keeps lopsided diagrams under the pixel budget after rounding', () => {
    const cases: Array<[number, number]> = [
      [3129, 50_000],
      [50_000, 3129],
      [1, 90_000],
      [7777, 33_333],
      [12_345, 4321],
    ];

    for (const [width, height] of cases) {
      const canvas = resolveCanvasDimensions(width, height);
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_777_216);
      expect(canvas.width).toBeLessThanOrEqual(16_384);
      expect(canvas.height).toBeLessThanOrEqual(16_384);
    }
  });

  it('downloads a fresh SVG blob with a format-specific filename', () => {
    createObjectURL.mockReturnValue('blob:svg-download');

    downloadMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg" />', 'flow.mmd');

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/svg+xml;charset=utf-8');
    expect(mockTriggerDownload).toHaveBeenCalledWith('blob:svg-download', 'flow.svg');
  });

  it('rasterizes a themed PNG at 2x from a canvas-safe SVG data URL', async () => {
    const image = document.createElement('img');
    let imageSource = '';
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 100 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 50 });
    Object.defineProperty(image, 'src', {
      configurable: true,
      set: (value: string) => {
        imageSource = value;
        image.onload?.(new Event('load'));
      },
    });
    const imageSpy = jest.spyOn(window, 'Image').mockImplementation(() => image);
    const drawImage = jest.fn();
    const fillRect = jest.fn();
    const context: CanvasRenderingContext2D = Object.create(null);
    context.drawImage = drawImage;
    context.fillRect = fillRect;
    context.imageSmoothingEnabled = false;
    context.imageSmoothingQuality = 'low';
    const canvases: HTMLCanvasElement[] = [];
    const getContextSpy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(function (this: HTMLCanvasElement) {
        canvases.push(this);
        return context;
      });
    const toBlobSpy = jest
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((callback) => callback(new Blob(['png'], { type: 'image/png' })));
    createObjectURL.mockReturnValue('blob:png-output');

    await downloadMermaidPng(
      '<svg xmlns="http://www.w3.org/2000/svg" />',
      'flow.mermaid',
      { width: 100, height: 50 },
      'rgb(247 247 248)',
    );

    expect(canvases[0]).toMatchObject({ width: 200, height: 100 });
    expect(context.fillStyle).toBe('rgb(247 247 248)');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 200, 100);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 200, 100);
    expect(imageSource).toMatch(/^data:image\/svg\+xml;charset=utf-8;base64,/);
    expect(atob(imageSource.split(',')[1])).toContain('<svg');
    expect(mockTriggerDownload).toHaveBeenCalledWith('blob:png-output', 'flow.png');

    imageSpy.mockRestore();
    getContextSpy.mockRestore();
    toBlobSpy.mockRestore();
  });

  it('does not download when PNG encoding fails', async () => {
    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 100 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 50 });
    Object.defineProperty(image, 'src', {
      configurable: true,
      set: () => image.onload?.(new Event('load')),
    });
    const imageSpy = jest.spyOn(window, 'Image').mockImplementation(() => image);
    const context: CanvasRenderingContext2D = Object.create(null);
    context.drawImage = jest.fn();
    const getContextSpy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context);
    const toBlobSpy = jest
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((callback) => callback(null));
    await expect(
      downloadMermaidPng('<svg xmlns="http://www.w3.org/2000/svg" />', 'flow'),
    ).rejects.toThrow('Failed to encode Mermaid diagram as PNG');
    expect(mockTriggerDownload).not.toHaveBeenCalled();

    imageSpy.mockRestore();
    getContextSpy.mockRestore();
    toBlobSpy.mockRestore();
  });
});
