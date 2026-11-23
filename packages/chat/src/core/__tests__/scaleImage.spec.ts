/**
 * @jest-environment jsdom
 */
import type { RefObject } from 'react';
import { scaleImage } from '../scaleImage';

function makeContainerRef(clientWidth: number): RefObject<HTMLDivElement> {
  return {
    current: { clientWidth } as HTMLDivElement,
  };
}

const originalInnerHeight = window.innerHeight;

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { value: 1000, writable: true });
});

afterEach(() => {
  Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, writable: true });
});

describe('scaleImage', () => {
  it('returns auto dimensions when containerRef is null', () => {
    const result = scaleImage({
      originalWidth: 1024,
      originalHeight: 1024,
      containerRef: { current: null },
    });
    expect(result).toEqual({ width: 'auto', height: 'auto' });
  });

  it('scales a square image to fit container width, clamped by max height', () => {
    // container=512, but 512px height exceeds 45vh (450px), so clamped
    const result = scaleImage({
      originalWidth: 1024,
      originalHeight: 1024,
      containerRef: makeContainerRef(512),
    });
    expect(result).toEqual({ width: '450px', height: '450px' });
  });

  it('scales to container width when height stays within max', () => {
    const result = scaleImage({
      originalWidth: 1024,
      originalHeight: 1024,
      containerRef: makeContainerRef(300),
    });
    expect(result).toEqual({ width: '300px', height: '300px' });
  });

  it('does not upscale when container is wider than the image', () => {
    const result = scaleImage({
      originalWidth: 256,
      originalHeight: 256,
      containerRef: makeContainerRef(800),
    });
    expect(result).toEqual({ width: '256px', height: '256px' });
  });

  it('constrains height to 45vh and adjusts width by aspect ratio', () => {
    // window.innerHeight = 1000, so maxHeight = 450
    const result = scaleImage({
      originalWidth: 500,
      originalHeight: 1000,
      containerRef: makeContainerRef(600),
    });
    // container fits 500px width → height would be 1000, exceeds 450
    // clamp: height=450, width=450*(500/1000)=225
    expect(result).toEqual({ width: '225px', height: '450px' });
  });

  it('handles landscape images correctly', () => {
    const result = scaleImage({
      originalWidth: 1920,
      originalHeight: 1080,
      containerRef: makeContainerRef(800),
    });
    // width clamped to 800, height = 800 / (1920/1080) = 450, exactly maxHeight
    expect(result).toEqual({ width: '800px', height: '450px' });
  });

  it('handles very wide panoramic images', () => {
    const result = scaleImage({
      originalWidth: 4000,
      originalHeight: 500,
      containerRef: makeContainerRef(600),
    });
    // width clamped to 600, height = 600 / (4000/500) = 75, well under maxHeight
    expect(result).toEqual({ width: '600px', height: '75px' });
  });
});
