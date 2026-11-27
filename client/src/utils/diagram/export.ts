import { fixSubgraphTitleContrast } from '~/utils/mermaid';
import { triggerDownload } from '~/utils/downloadFile';

const PNG_EXPORT_SCALE = 2;
const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_PIXELS = 16_777_216;

export interface MermaidDimensions {
  width: number;
  height: number;
}

export interface ProcessedMermaidSvg {
  svg: string;
  dimensions: MermaidDimensions | null;
}

function absoluteDimension(value: string | null): number {
  const normalized = value?.trim() ?? '';
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i.test(normalized)) {
    return 0;
  }
  return parseFloat(normalized);
}

function applyFallbackFixes(svg: string): string {
  let result = svg;

  if (!svg.includes('viewBox') && svg.includes('height=') && svg.includes('width=')) {
    const widthMatch = svg.match(/width="([\d.]+)"/);
    const heightMatch = svg.match(/height="([\d.]+)"/);
    if (widthMatch && heightMatch) {
      result = result.replace('<svg', `<svg viewBox="0 0 ${widthMatch[1]} ${heightMatch[1]}"`);
    }
  }

  if (!result.includes('xmlns')) {
    result = result.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  return result;
}

function roundMermaidNodeCorners(svgElement: Element): void {
  const radius = 8;

  for (const rectangle of svgElement.querySelectorAll('g.node rect')) {
    const currentRadius = Number.parseFloat(rectangle.getAttribute('rx') ?? '');
    if (Number.isFinite(currentRadius) && currentRadius >= radius) {
      continue;
    }

    rectangle.setAttribute('rx', String(radius));
    rectangle.setAttribute('ry', String(radius));
  }
}

export function processMermaidSvg(svg: string): ProcessedMermaidSvg {
  const parser = new DOMParser();
  const document = parser.parseFromString(svg, 'image/svg+xml');

  if (document.querySelector('parsererror')) {
    return { svg: applyFallbackFixes(svg), dimensions: null };
  }

  const svgElement = document.querySelector('svg');
  if (!svgElement) {
    return { svg: applyFallbackFixes(svg), dimensions: null };
  }

  let width = absoluteDimension(svgElement.getAttribute('width'));
  let height = absoluteDimension(svgElement.getAttribute('height'));

  if (!width || !height) {
    const viewBox = svgElement.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number);
      if (parts.length === 4) {
        width = parts[2];
        height = parts[3];
      }
    }
  }

  let dimensions: MermaidDimensions | null = null;
  if (width > 0 && height > 0) {
    dimensions = { width, height };
    if (!svgElement.getAttribute('viewBox')) {
      svgElement.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
    svgElement.removeAttribute('width');
    svgElement.removeAttribute('height');
    svgElement.removeAttribute('style');
  }

  if (!svgElement.getAttribute('xmlns')) {
    svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }

  fixSubgraphTitleContrast(svgElement);
  roundMermaidNodeCorners(svgElement);

  return {
    svg: new XMLSerializer().serializeToString(document),
    dimensions,
  };
}

export function applyMermaidBackground(svg: string, background?: string): string {
  if (!background) {
    return svg;
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(svg, 'image/svg+xml');
  const svgElement = document.querySelector('svg');
  if (!svgElement || document.querySelector('parsererror')) {
    return svg;
  }

  const viewBox = svgElement
    .getAttribute('viewBox')
    ?.split(/[\s,]+/)
    .map(Number);
  const hasViewBox =
    viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0;
  const backgroundElement = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  backgroundElement.setAttribute('x', hasViewBox ? String(viewBox[0]) : '0');
  backgroundElement.setAttribute('y', hasViewBox ? String(viewBox[1]) : '0');
  backgroundElement.setAttribute('width', hasViewBox ? String(viewBox[2]) : '100%');
  backgroundElement.setAttribute('height', hasViewBox ? String(viewBox[3]) : '100%');
  backgroundElement.setAttribute('fill', background);
  backgroundElement.setAttribute('data-mermaid-export-background', 'true');
  svgElement.insertBefore(backgroundElement, svgElement.firstChild);

  return new XMLSerializer().serializeToString(document);
}

function exportFilename(filename: string, extension: 'svg' | 'png'): string {
  const baseName = filename
    .trim()
    .replace(/\.(?:mermaid|mmd|svg|png)$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .trim();
  return `${baseName || 'mermaid-diagram'}.${extension}`;
}

function svgBlob(svg: string): Blob {
  return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Failed to prepare Mermaid SVG for PNG export'));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(new Error('Failed to prepare Mermaid SVG for PNG export'));
    reader.readAsDataURL(blob);
  });
}

function loadSvgImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load Mermaid SVG for PNG export'));
    image.src = url;
  });
}

export function resolveCanvasDimensions(width: number, height: number): MermaidDimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Mermaid diagram has invalid export dimensions');
  }

  const scale = Math.min(
    PNG_EXPORT_SCALE,
    MAX_CANVAS_DIMENSION / width,
    MAX_CANVAS_DIMENSION / height,
    Math.sqrt(MAX_CANVAS_PIXELS / (width * height)),
  );

  /* Round down: rounding each side independently can carry the product back
   * over the pixel budget the scale was chosen to satisfy, and a canvas above
   * that area makes `toBlob` fail outright in browsers that enforce it. */
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to encode Mermaid diagram as PNG'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

export function downloadMermaidSvg(svg: string, filename: string, background?: string): void {
  const url = URL.createObjectURL(svgBlob(applyMermaidBackground(svg, background)));
  triggerDownload(url, exportFilename(filename, 'svg'));
}

export async function downloadMermaidPng(
  svg: string,
  filename: string,
  dimensions?: MermaidDimensions | null,
  background?: string,
): Promise<void> {
  const sourceUrl = await blobDataUrl(svgBlob(svg));
  const image = await loadSvgImage(sourceUrl);
  const sourceWidth = dimensions?.width || image.naturalWidth || image.width;
  const sourceHeight = dimensions?.height || image.naturalHeight || image.height;
  const canvasDimensions = resolveCanvasDimensions(sourceWidth, sourceHeight);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Canvas is unavailable for Mermaid PNG export');
  }

  canvas.width = canvasDimensions.width;
  canvas.height = canvasDimensions.height;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const png = await encodePng(canvas);
  const outputUrl = URL.createObjectURL(png);
  triggerDownload(outputUrl, exportFilename(filename, 'png'));
}
