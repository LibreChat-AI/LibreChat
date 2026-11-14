/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import { setAppPartRenderers } from '../Parts/slots';
import FilePreviewDialog from '../FilePreviewDialog';
import Image from '../Image';
import Files from '../Files';

jest.mock('~/Providers', () => ({
  useFileMapContext: () => ({}),
  useShareContext: () => ({}),
}));
jest.mock(
  '../Image',
  () =>
    ({ alignRight, className }: { alignRight?: boolean; className?: string }) => (
      <div
        data-testid="image-preview"
        data-aligned-right={String(alignRight)}
        className={className}
      >
        image preview
      </div>
    ),
);
jest.mock(
  '../FilePreviewDialog',
  () =>
    ({ open, deliveryPath }: { open: boolean; deliveryPath?: string }) =>
      open ? <div>preview: {deliveryPath}</div> : null,
);

setAppPartRenderers({
  renderMarkdown: () => null,
  renderAgentIcon: () => null,
  renderImage: (props) => <Image {...props} />,
  renderFilePreview: (props) => <FilePreviewDialog {...props} />,
});

it('exposes extracted image text without changing ordinary image previews', () => {
  render(
    <Files
      message={
        {
          files: [
            {
              file_id: 'text-image',
              filename: 'extracted.png',
              type: 'image/png',
              llmDeliveryPath: 'text',
            },
            { file_id: 'image', type: 'image/png' },
          ],
        } as TMessage
      }
    />,
  );
  expect(screen.getAllByText('image preview')).toHaveLength(1);
  expect(screen.getByTestId('image-preview')).toHaveAttribute('data-aligned-right', 'true');
  expect(screen.getByRole('button', { name: 'extracted.png' })).toHaveClass(
    'border-surface-user-message',
    'max-w-full',
    'bg-transparent',
  );
  expect(screen.getByTestId('image-preview')).toHaveClass(
    'border-surface-user-message',
    'mt-0',
    'shadow-none',
  );
  fireEvent.click(screen.getByRole('button', { name: 'extracted.png' }));
  expect(screen.getByText('preview: text')).toBeInTheDocument();
});

it('shows the persisted snippet after reload without the owner file cache', () => {
  const saved = JSON.parse(
    JSON.stringify({
      files: [
        {
          file_id: 'stored-paste',
          type: 'text/plain',
          filename: 'pasted-text.txt',
          textPreview: 'An excerpt retained on the saved message.',
        },
      ],
    }),
  ) as TMessage;
  render(<Files message={saved} />);
  expect(screen.getByText('An excerpt retained on the saved message.')).toBeInTheDocument();
});
