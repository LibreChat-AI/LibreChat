/**
 * @jest-environment jsdom
 */
import React, { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FileSources } from 'librechat-data-provider';
import type { ExtendedFile } from '../../../../core/files';
import { initEnglish } from '../../../../__fixtures__/i18n';
import FileRow from '../FileRow';

beforeAll(initEnglish);

const file: ExtendedFile = {
  file_id: 'doc-1',
  type: 'application/pdf',
  filename: 'document.pdf',
  progress: 1,
  size: 10,
  source: FileSources.local,
};

function Harness(): React.JSX.Element {
  const [files, setFiles] = useState<Map<string, ExtendedFile>>(new Map([[file.file_id, file]]));
  return <FileRow files={files} setFiles={setFiles} />;
}

describe('FileRow without a files host', () => {
  it('removes the deleted file from the map', async () => {
    render(<Harness />);

    expect(screen.getByText('document.pdf')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove file' }));

    expect(screen.queryByText('document.pdf')).not.toBeInTheDocument();
  });
});
