import { ARTIFACT_PREVIEW_MAX_URL_LENGTH } from 'librechat-data-provider';
import {
  ARTIFACT_PREVIEW_BRIDGE_SCRIPT,
  ARTIFACT_PREVIEW_MAX_SNAPSHOT_LENGTH,
  getArtifactPreviewDrawRect,
  requestArtifactPreviewFromFrame,
  sanitizeArtifactPreviewCss,
  toArtifactPreviewSvgDataUrl,
  toArtifactPreview,
} from './artifactPreviewCapture';

const pngPreview =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('artifact preview capture', () => {
  it('creates preview metadata only for a self-contained validated raster', () => {
    expect(toArtifactPreview(pngPreview, 'Revenue chart')).toEqual({
      type: 'image',
      imageUrl: pngPreview,
      alt: 'Revenue chart',
    });
    expect(toArtifactPreview('https://attacker.example/pixel.png')).toBeUndefined();
  });

  it('installs the nonce-scoped bridge in artifact frames', () => {
    expect(ARTIFACT_PREVIEW_BRIDGE_SCRIPT).toContain('librechat:artifact-preview:request');
    expect(ARTIFACT_PREVIEW_BRIDGE_SCRIPT).toContain('requestId');
    expect(ARTIFACT_PREVIEW_BRIDGE_SCRIPT).toContain('animation-delay: -100000s !important');
    expect(ARTIFACT_PREVIEW_BRIDGE_SCRIPT).toContain('animation-fill-mode: both !important');
    expect(ARTIFACT_PREVIEW_BRIDGE_SCRIPT).toContain(String(ARTIFACT_PREVIEW_MAX_SNAPSHOT_LENGTH));
    expect(ARTIFACT_PREVIEW_BRIDGE_SCRIPT).toContain(String(ARTIFACT_PREVIEW_MAX_URL_LENGTH));
    expect(ARTIFACT_PREVIEW_BRIDGE_SCRIPT).toContain('snapshot_too_large');
    expect(ARTIFACT_PREVIEW_BRIDGE_SCRIPT).toContain('maxCanvasUrlLength');
  });

  it('removes network-backed CSS resources from the rasterized clone', () => {
    const css = `
      @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;700;900&display=swap');
      .hero {
        background-image: url("https://attacker.example/background.png");
        color: rgb(12, 34, 56);
      }
    `;

    const sanitized = sanitizeArtifactPreviewCss(css);

    expect(sanitized).not.toContain('@import');
    expect(sanitized).not.toContain('https://');
    expect(sanitized).toContain('background-image: none');
    expect(sanitized).toContain('color: rgb(12, 34, 56)');
  });

  it('rasterizes the sandbox snapshot from a self-contained SVG data URL', () => {
    const dataUrl = toArtifactPreviewSvgDataUrl(
      {
        serialized: '<html xmlns="http://www.w3.org/1999/xhtml"><body>Hello</body></html>',
        backgroundColor: '#ffffff',
      },
      640,
      480,
    );

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(decodeURIComponent(dataUrl)).toContain('viewBox="0 0 640 480"');
    expect(decodeURIComponent(dataUrl)).toContain('<body>Hello</body>');
  });

  it('anchors cover crops to the artifact top-left corner', () => {
    expect(getArtifactPreviewDrawRect(600, 900, 480, 320)).toEqual({
      x: 0,
      y: 0,
      width: 480,
      height: 720,
    });
    expect(getArtifactPreviewDrawRect(1200, 600, 480, 320)).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 320,
    });
  });

  it('accepts a validated preview only from the requested artifact frame', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const frameWindow = frame.contentWindow as Window;
    const postMessage = jest.spyOn(frameWindow, 'postMessage').mockImplementation((message) => {
      window.setTimeout(() => {
        const event = new MessageEvent('message', {
          data: {
            type: 'librechat:artifact-preview:response',
            requestId: message.requestId,
            imageUrl: pngPreview,
          },
        });
        Object.defineProperty(event, 'source', { value: frameWindow });
        window.dispatchEvent(event);
      }, 0);
    });

    await expect(requestArtifactPreviewFromFrame(frame, 100)).resolves.toBe(pngPreview);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'librechat:artifact-preview:request' }),
      '*',
    );
    frame.remove();
  });

  it('rejects an external preview returned by an artifact frame', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const frameWindow = frame.contentWindow as Window;
    jest.spyOn(frameWindow, 'postMessage').mockImplementation((message) => {
      window.setTimeout(() => {
        const event = new MessageEvent('message', {
          data: {
            type: 'librechat:artifact-preview:response',
            requestId: message.requestId,
            imageUrl: 'https://attacker.example/pixel.png',
          },
        });
        Object.defineProperty(event, 'source', { value: frameWindow });
        window.dispatchEvent(event);
      }, 0);
    });

    await expect(requestArtifactPreviewFromFrame(frame, 100)).resolves.toBeNull();
    frame.remove();
  });

  it('rejects an oversized sandbox snapshot before rasterization', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const frameWindow = frame.contentWindow as Window;
    const imageSpy = jest.spyOn(global, 'Image');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(frameWindow, 'postMessage').mockImplementation((message) => {
      window.setTimeout(() => {
        const event = new MessageEvent('message', {
          data: {
            type: 'librechat:artifact-preview:response',
            requestId: message.requestId,
            snapshot: {
              serialized: 'x'.repeat(ARTIFACT_PREVIEW_MAX_SNAPSHOT_LENGTH + 1),
              backgroundColor: '#ffffff',
            },
          },
        });
        Object.defineProperty(event, 'source', { value: frameWindow });
        window.dispatchEvent(event);
      }, 0);
    });

    await expect(requestArtifactPreviewFromFrame(frame, 100)).resolves.toBeNull();
    expect(imageSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[ArtifactPreview] Capture bridge returned an invalid snapshot',
    );
    warnSpy.mockRestore();
    imageSpy.mockRestore();
    frame.remove();
  });
});
