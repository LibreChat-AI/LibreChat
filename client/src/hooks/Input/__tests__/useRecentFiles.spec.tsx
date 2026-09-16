import { renderHook } from '@testing-library/react';
import type { TFile } from 'librechat-data-provider';
import useRecentFiles, { RECENT_FILE_COUNT } from '../useRecentFiles';

/**
 * The palette's "your files" section: a short server-sorted page while idle,
 * the full list once the user starts searching.
 */

let mockRecent: TFile[] | undefined;
let mockAll: TFile[] | undefined;
let mockRecentEnabled: boolean | undefined;
let mockAllEnabled: boolean | undefined;
let mockLimit: number | undefined;

jest.mock('~/data-provider', () => ({
  useGetRecentFiles: (limit: number, config?: { enabled?: boolean }) => {
    mockLimit = limit;
    mockRecentEnabled = config?.enabled;
    return { data: mockRecent };
  },
  useGetFiles: (config?: { enabled?: boolean }) => {
    mockAllEnabled = config?.enabled;
    return { data: mockAll };
  },
}));

jest.mock('~/hooks/Files/useAttachExisting', () => ({
  __esModule: true,
  default: () => jest.fn(),
}));

const file = (over: Partial<TFile>): TFile => ({ file_id: 'f', ...over }) as TFile;

const context = {
  files: new Map(),
  setFiles: jest.fn(),
  conversation: null,
};

const recent = (enabled = true, search = '') =>
  renderHook(() => useRecentFiles(enabled, context, search)).result.current;

describe('useRecentFiles', () => {
  beforeEach(() => {
    mockRecent = undefined;
    mockAll = undefined;
    mockRecentEnabled = undefined;
    mockAllEnabled = undefined;
    mockLimit = undefined;
  });

  it('fetches the recent page only while the palette is open and unsearched', () => {
    recent(false);
    expect(mockRecentEnabled).toBe(false);
    expect(mockAllEnabled).toBe(false);

    recent(true);
    expect(mockRecentEnabled).toBe(true);
    expect(mockAllEnabled).toBe(false);
    expect(mockLimit).toBe(RECENT_FILE_COUNT);
  });

  it('switches to the full list once the user starts typing', () => {
    recent(true, 'report');
    expect(mockRecentEnabled).toBe(false);
    expect(mockAllEnabled).toBe(true);
  });

  it('lists nothing before the files have loaded', () => {
    expect(recent().files).toEqual([]);
  });

  it('returns the server-sorted recent page as-is when unsearched', () => {
    mockRecent = [
      file({ file_id: 'newest' }),
      file({ file_id: 'middle' }),
      file({ file_id: 'older' }),
    ];
    expect(recent().files.map((item) => item.file_id)).toEqual(['newest', 'middle', 'older']);
  });

  it('filters the full list by filename when searching', () => {
    mockAll = [
      file({ file_id: 'a', filename: 'alpha.pdf' }),
      file({ file_id: 'b', filename: 'report-final.pdf' }),
      file({ file_id: 'c', filename: 'notes.txt' }),
    ];
    expect(recent(true, 'report').files.map((item) => item.file_id)).toEqual(['b']);
  });
});
