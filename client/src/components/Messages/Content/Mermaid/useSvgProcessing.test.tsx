import { renderHook } from '@testing-library/react';
import useSvgProcessing from './useSvgProcessing';

let mockMermaidResult: {
  svg: string | undefined;
  isLoading: boolean;
  error: Error | undefined;
};

jest.mock('~/hooks', () => ({
  useDebouncedMermaid: () => mockMermaidResult,
}));

describe('useSvgProcessing', () => {
  let createObjectURL: jest.Mock;
  let revokeObjectURL: jest.Mock;

  beforeEach(() => {
    mockMermaidResult = {
      svg: '<svg width="400" height="200"><path /></svg>',
      isLoading: false,
      error: undefined,
    };
    createObjectURL = jest
      .fn()
      .mockReturnValueOnce('blob:first-diagram')
      .mockReturnValueOnce('blob:second-diagram');
    revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
  });

  it('observes the diagram canvas once it replaces the loading placeholder', () => {
    const observerConstructor = window.ResizeObserver as unknown as jest.Mock;
    observerConstructor.mockClear();

    /* The placeholder shown while the first diagram renders carries no ref, so
     * the canvas only exists from the render that has a blob URL. */
    mockMermaidResult = { svg: undefined, isLoading: true, error: undefined };
    const containerRef: { current: HTMLDivElement | null } = { current: null };
    const { rerender } = renderHook(
      ({ content }) => useSvgProcessing({ content, id: 'diagram', retryCount: 0, containerRef }),
      { initialProps: { content: 'graph TD' } },
    );

    expect(observerConstructor).not.toHaveBeenCalled();

    const canvas = document.createElement('div');
    containerRef.current = canvas;
    mockMermaidResult = {
      svg: '<svg width="400" height="200"><path /></svg>',
      isLoading: false,
      error: undefined,
    };
    rerender({ content: 'graph TD\nA-->B' });

    const observer = observerConstructor.mock.results.at(-1)?.value as { observe: jest.Mock };
    expect(observer.observe).toHaveBeenCalledWith(canvas);
  });

  it('keeps the last diagram URL while streaming and revokes it after replacement', () => {
    const containerRef = { current: null };
    const { result, rerender, unmount } = renderHook(
      ({ content }) =>
        useSvgProcessing({
          content,
          id: 'diagram',
          retryCount: 0,
          containerRef,
        }),
      { initialProps: { content: 'graph TD\nA-->B' } },
    );

    expect(result.current.blobUrl).toBe('blob:first-diagram');

    mockMermaidResult = { svg: undefined, isLoading: true, error: undefined };
    rerender({ content: 'graph TD\nA-->' });

    expect(result.current.blobUrl).toBe('blob:first-diagram');
    expect(result.current.processedSvg).toContain('viewBox="0 0 400 200"');
    expect(result.current.svgDimensions).toEqual({ width: 400, height: 200 });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    mockMermaidResult = {
      svg: '<svg width="500" height="250"><path /></svg>',
      isLoading: false,
      error: undefined,
    };
    rerender({ content: 'graph TD\nA-->C' });

    expect(result.current.blobUrl).toBe('blob:second-diagram');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first-diagram');

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:second-diagram');
  });
});
