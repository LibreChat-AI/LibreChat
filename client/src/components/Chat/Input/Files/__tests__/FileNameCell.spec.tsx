import React from 'react';
import { FileSources } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { TFile } from 'librechat-data-provider';
import FileNameCell from '../FileNameCell';

jest.mock('~/data-provider', () => ({
  useFilePreview: () => ({ data: undefined, isInitialLoading: false, isError: false }),
}));

jest.mock('~/components/Chat/Input/Files/FilePreview', () => ({
  __esModule: true,
  default: () => <div data-testid="file-icon" />,
}));

const makeFile = (type: string, source: FileSources = FileSources.text): TFile =>
  ({
    file_id: 'file-1',
    filename: 'report.bin',
    type,
    filepath: '/uploads/report.bin',
    source,
  }) as TFile;

describe('FileNameCell', () => {
  test.each([
    ['application/pdf', 'pdf'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ['application/vnd.oasis.opendocument.text', 'odt'],
  ])('offers the extracted text for %s', (mimetype) => {
    render(<FileNameCell file={makeFile(mimetype)} />);

    expect(screen.getByRole('button', { name: /view text extracted from/i })).toBeInTheDocument();
  });

  test.each([
    ['image/png', 'image'],
    ['text/plain', 'plain text'],
    ['application/zip', 'archive'],
  ])('renders %s as plain text with no affordance', (mimetype) => {
    render(<FileNameCell file={makeFile(mimetype)} />);

    /* Only parsed documents have hidden extracted text worth surfacing; adding a
     * control for every row would promise content that is not there. */
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('report.bin')).toBeInTheDocument();
  });

  test.each([
    [FileSources.local, 'file_search'],
    [FileSources.execute_code, 'code interpreter'],
    [FileSources.s3, 'object storage'],
  ])('offers nothing for a PDF stored as a binary via %s', (source) => {
    /* Only the parser writes `text`, and every record it writes carries
     * `FileSources.text`. The same PDF uploaded to file_search or execute_code is
     * stored whole, so the control would always land on an empty state. */
    render(<FileNameCell file={makeFile('application/pdf', source)} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('report.bin')).toBeInTheDocument();
  });

  test('offers nothing when the record carries no source at all', () => {
    const file = makeFile('application/pdf');
    delete (file as Partial<TFile>).source;

    render(<FileNameCell file={file} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('the trigger names the file for screen readers', () => {
    render(<FileNameCell file={makeFile('application/pdf')} />);

    expect(
      screen.getByRole('button', { name: 'View text extracted from report.bin' }),
    ).toBeInTheDocument();
  });
});
