import React from 'react';
import { render, screen } from '@testing-library/react';
import { FileSources } from 'librechat-data-provider';
import ImageFile from '../ImageFile';

const mockRefetch = jest.fn();
const mockUseFileDownloadArgs = jest.fn();

jest.mock('recoil', () => ({
  useRecoilValue: () => ({ id: 'user-1' }),
}));

jest.mock('~/store', () => ({ __esModule: true, default: { user: 'user' } }));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) =>
    classes.filter((c): c is string => typeof c === 'string' && c.length > 0).join(' '),
}));

jest.mock('~/data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    useFileDownload: (...args: unknown[]) => {
      mockUseFileDownloadArgs(...args);
      return { refetch: mockRefetch };
    },
    revokeDownloadURL: jest.fn(),
    isProxyImageSource: (source?: string | null) => source === actual.FileSources.azure_blob,
  };
});

jest.mock('../Image', () => ({
  __esModule: true,
  default: ({ imagePath, altText }: { imagePath: string; altText: string }) => (
    <div data-testid="image" data-src={imagePath} data-alt={altText} />
  ),
}));

jest.mock('@librechat/client', () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className} />
  ),
}));

describe('ImageFile', () => {
  const azureFile = {
    file_id: 'file-1',
    filepath: 'https://acct.blob.core.windows.net/files/images/u/img.png',
    filename: 'img.png',
    source: FileSources.azure_blob,
    width: 100,
    height: 200,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('proxies private azure blob images through the authenticated download endpoint', async () => {
    mockRefetch.mockResolvedValue({ data: 'blob:proxy-url' });
    render(<ImageFile file={azureFile} />);

    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockUseFileDownloadArgs).toHaveBeenCalledWith('user-1', 'file-1', {
      source: FileSources.azure_blob,
      direct: false,
    });

    const img = await screen.findByTestId('image');
    expect(img).toHaveAttribute('data-src', 'blob:proxy-url');
  });

  it('renders direct-download sources from their URL without proxying', () => {
    render(
      <ImageFile
        file={{ ...azureFile, source: FileSources.s3, filepath: 'https://signed.example/img' }}
      />,
    );

    expect(mockRefetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('image')).toHaveAttribute('data-src', 'https://signed.example/img');
  });

  it('prefers a local preview and skips the proxy', () => {
    render(<ImageFile file={azureFile} localPreview="blob:local-preview" />);

    expect(mockRefetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('image')).toHaveAttribute('data-src', 'blob:local-preview');
  });
});
