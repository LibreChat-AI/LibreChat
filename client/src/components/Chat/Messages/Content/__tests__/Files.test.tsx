/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import Files from '../Files';

jest.mock('~/Providers', () => ({
  useFileMapContext: () => ({}),
  useShareContext: () => ({}),
}));
jest.mock(
  '~/components/Chat/Input/Files/FileContainer',
  () =>
    ({ onClick, buttonClassName }: { onClick: () => void; buttonClassName?: string }) => (
      <button className={buttonClassName} onClick={onClick}>
        file action
      </button>
    ),
);
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

it('exposes extracted image text without changing ordinary image previews', () => {
  render(
    <Files
      message={
        {
          files: [
            { file_id: 'text-image', type: 'image/png', llmDeliveryPath: 'text' },
            { file_id: 'image', type: 'image/png' },
          ],
        } as TMessage
      }
    />,
  );
  expect(screen.getAllByText('image preview')).toHaveLength(1);
  expect(screen.getByTestId('image-preview')).toHaveAttribute('data-aligned-right', 'true');
  expect(screen.getByText('file action')).toHaveClass(
    'border-surface-user-message',
    'max-w-full',
    'bg-transparent',
  );
  expect(screen.getByTestId('image-preview')).toHaveClass(
    'border-surface-user-message',
    'mt-0',
    'shadow-none',
  );
  fireEvent.click(screen.getByText('file action'));
  expect(screen.getByText('preview: text')).toBeInTheDocument();
});
