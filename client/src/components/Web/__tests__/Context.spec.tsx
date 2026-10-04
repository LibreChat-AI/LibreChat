import { renderHook } from '@testing-library/react';

import { SearchContext } from '~/Providers';
import { useCitation } from '../Context';

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SearchContext.Provider
      value={{
        searchResults: {
          '0': {
            turn: 0,
            images: [
              { link: 'https://img.example/1.png', title: 'Shot' },
              { link: 'https://img.example/2.png', title: 'Another' },
            ],
            videos: [
              { link: 'https://video.example/1.mp4', title: 'Video 1' },
              { link: 'https://video.example/2.mp4', title: 'Video 2' },
            ],
          },
        },
      }}
    >
      {children}
    </SearchContext.Provider>
  );
}

describe('useCitation', () => {
  it('resolves an image anchor to the images array', () => {
    const { result } = renderHook(() => useCitation({ turn: 0, refType: 'image', index: 0 }), {
      wrapper,
    });

    expect(result.current).toBeDefined();
    expect(result.current?.link).toBe('https://img.example/1.png');
    expect(result.current?.title).toBe('Shot');
  });

  it('resolves a video anchor to the videos array', () => {
    const { result } = renderHook(() => useCitation({ turn: 0, refType: 'video', index: 0 }), {
      wrapper,
    });

    expect(result.current).toBeDefined();
    expect(result.current?.link).toBe('https://video.example/1.mp4');
    expect(result.current?.title).toBe('Video 1');
  });

  it('resolves image index 1 correctly', () => {
    const { result } = renderHook(() => useCitation({ turn: 0, refType: 'image', index: 1 }), {
      wrapper,
    });

    expect(result.current).toBeDefined();
    expect(result.current?.link).toBe('https://img.example/2.png');
    expect(result.current?.title).toBe('Another');
  });

  it('resolves video index 1 correctly', () => {
    const { result } = renderHook(() => useCitation({ turn: 0, refType: 'video', index: 1 }), {
      wrapper,
    });

    expect(result.current).toBeDefined();
    expect(result.current?.link).toBe('https://video.example/2.mp4');
    expect(result.current?.title).toBe('Video 2');
  });

  it('returns undefined for out-of-bounds image index', () => {
    const { result } = renderHook(() => useCitation({ turn: 0, refType: 'image', index: 99 }), {
      wrapper,
    });

    expect(result.current).toBeUndefined();
  });

  it('returns undefined for out-of-bounds video index', () => {
    const { result } = renderHook(() => useCitation({ turn: 0, refType: 'video', index: 99 }), {
      wrapper,
    });

    expect(result.current).toBeUndefined();
  });
});
