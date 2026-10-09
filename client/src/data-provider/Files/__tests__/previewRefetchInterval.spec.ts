import { FileSources } from 'librechat-data-provider';
import type { TFilePreview } from 'librechat-data-provider';

const mockGetFilePreview = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getFilePreview: (...args: unknown[]) => mockGetFilePreview(...args),
    },
  };
});

import {
  PREVIEW_MAX_CONSECUTIVE_ERRORS,
  _resetPreviewErrorCounter,
  fetchFilePreview,
  isDirectDownloadSource,
  previewRefetchInterval,
  revokeDownloadURL,
} from '../queries';

const q = (fileId: string) => ({ queryKey: ['filePreview' as const, fileId] });
const FID = 'fid-test';

beforeEach(() => {
  _resetPreviewErrorCounter();
  mockGetFilePreview.mockReset();
});

describe('previewRefetchInterval', () => {
  it('polls every 2.5s when no data has arrived yet', () => {
    expect(previewRefetchInterval(undefined, q(FID))).toBe(2500);
  });

  it('keeps polling while server reports pending', () => {
    expect(previewRefetchInterval({ file_id: FID, status: 'pending' }, q(FID))).toBe(2500);
  });

  it('stops on terminal ready', () => {
    const data: TFilePreview = {
      file_id: FID,
      status: 'ready',
      text: 'x',
      textFormat: 'html',
    };
    expect(previewRefetchInterval(data, q(FID))).toBe(false);
  });

  it('stops on terminal failed', () => {
    const data: TFilePreview = { file_id: FID, status: 'failed', previewError: 'oops' };
    expect(previewRefetchInterval(data, q(FID))).toBe(false);
  });

  it('keeps polling while consecutive errors are below the cap', async () => {
    /* Regression for the bug where the counter relied on
     * `query.state.fetchFailureCount`, which React Query v4 resets to
     * 0 on every fetch dispatch — so the cap never fired and a broken
     * endpoint polled forever. The counter now lives outside query
     * state, incremented in the fetch wrapper. */
    mockGetFilePreview.mockRejectedValue(new Error('500'));
    for (let i = 0; i < PREVIEW_MAX_CONSECUTIVE_ERRORS - 1; i++) {
      await expect(fetchFilePreview(FID)).rejects.toThrow();
      expect(previewRefetchInterval(undefined, q(FID))).toBe(2500);
    }
  });

  it('caps polling after MAX_CONSECUTIVE_ERRORS errors', async () => {
    mockGetFilePreview.mockRejectedValue(new Error('500'));
    for (let i = 0; i < PREVIEW_MAX_CONSECUTIVE_ERRORS; i++) {
      await expect(fetchFilePreview(FID)).rejects.toThrow();
    }
    expect(previewRefetchInterval(undefined, q(FID))).toBe(false);
  });

  it('resets the error counter on a successful poll', async () => {
    mockGetFilePreview.mockRejectedValueOnce(new Error('500'));
    await expect(fetchFilePreview(FID)).rejects.toThrow();
    mockGetFilePreview.mockResolvedValueOnce({ file_id: FID, status: 'pending' });
    await fetchFilePreview(FID);
    /* After a success, even an immediate cap-worth of new errors should
     * be allowed before stopping again. */
    mockGetFilePreview.mockRejectedValue(new Error('500'));
    for (let i = 0; i < PREVIEW_MAX_CONSECUTIVE_ERRORS - 1; i++) {
      await expect(fetchFilePreview(FID)).rejects.toThrow();
    }
    expect(previewRefetchInterval(undefined, q(FID))).toBe(2500);
  });

  it('tracks counters per file_id (one broken endpoint does not affect another)', async () => {
    mockGetFilePreview.mockRejectedValue(new Error('500'));
    for (let i = 0; i < PREVIEW_MAX_CONSECUTIVE_ERRORS; i++) {
      await expect(fetchFilePreview('fid-broken')).rejects.toThrow();
    }
    expect(previewRefetchInterval(undefined, q('fid-broken'))).toBe(false);
    expect(previewRefetchInterval(undefined, q('fid-healthy'))).toBe(2500);
  });
});

describe('download URL helpers', () => {
  it('uses direct download URLs only for strategies that implement them', () => {
    expect(isDirectDownloadSource(FileSources.s3)).toBe(true);
    expect(isDirectDownloadSource(FileSources.cloudfront)).toBe(true);
    expect(isDirectDownloadSource(FileSources.local)).toBe(false);
    expect(isDirectDownloadSource(FileSources.firebase)).toBe(false);
    expect(isDirectDownloadSource(undefined)).toBe(false);
  });

  it('revokes only blob URLs', () => {
    const originalRevokeObjectURL = window.URL.revokeObjectURL;
    const revokeObjectURL = jest.fn();
    window.URL.revokeObjectURL = revokeObjectURL;

    revokeDownloadURL('https://cdn.example.com/file.pdf');
    revokeDownloadURL('blob:https://app.example.com/id');

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://app.example.com/id');
    window.URL.revokeObjectURL = originalRevokeObjectURL;
  });
});
