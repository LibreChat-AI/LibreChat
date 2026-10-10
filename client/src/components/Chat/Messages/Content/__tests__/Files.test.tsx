/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import Files from '../Files';

jest.mock('~/Providers', () => ({
  useFileMapContext: () => ({}),
  useShareContext: () => ({}),
}));
jest.mock(
  '~/components/Chat/Input/Files/FileContainer',
  () =>
    ({ onClick }: { onClick: () => void }) => <button onClick={onClick}>file action</button>,
);
jest.mock('../Image', () => ({ alignRight }: { alignRight?: boolean }) => (
  <div data-testid="image-preview" data-aligned-right={String(alignRight)}>
    image preview
  </div>
));
jest.mock(
  '../FilePreviewDialog',
  () =>
    ({ open, deliveryPath }: { open: boolean; deliveryPath?: string }) =>
      open ? <div>preview: {deliveryPath}</div> : null,
);

const Providers = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <RecoilRoot>{children}</RecoilRoot>
  </QueryClientProvider>
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
    { wrapper: Providers },
  );
  expect(screen.getAllByText('image preview')).toHaveLength(1);
  expect(screen.getByTestId('image-preview')).toHaveAttribute('data-aligned-right', 'true');
  fireEvent.click(screen.getByText('file action'));
  expect(screen.getByText('preview: text')).toBeInTheDocument();
});
