import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import type { TFile } from 'librechat-data-provider';
import DataTable from '../DataTable';
import { columns } from '../Columns';

const mockDeleteFiles = jest.fn();
jest.mock('~/hooks/Files', () => ({
  useDeleteFilesFromTable: () => ({ deleteFiles: mockDeleteFiles }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
/* jsdom has no layout, so the virtualized table would measure an empty viewport; render every row. */
jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 40,
        end: (index + 1) * 40,
        size: 40,
      })),
    getTotalSize: () => count * 40,
    measureElement: () => undefined,
  }),
}));
jest.mock('../ColumnVisibilityDropdown', () => ({ ColumnVisibilityDropdown: () => null }));
jest.mock('~/components/Chat/Input/Files/ImagePreview', () => () => null);
jest.mock('~/components/Chat/Input/Files/FilePreview', () => () => null);
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useMediaQuery: () => false,
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
}));

test('explains retained originals and excludes them from selecting all and deleting files', async () => {
  const user = userEvent.setup();
  const retained = {
    file_id: 'retained',
    filename: 'retained.png',
    type: 'image/png',
    deletionRestriction: 'retained_media',
  } as TFile;
  const ordinary = { file_id: 'ordinary', filename: 'ordinary.png', type: 'image/png' } as TFile;
  render(
    <RecoilRoot>
      <DataTable
        columns={columns.filter(
          (column) =>
            ('id' in column && column.id === 'select') ||
            ('accessorKey' in column && column.accessorKey === 'filename'),
        )}
        data={[retained, ordinary]}
      />
    </RecoilRoot>,
  );
  const rows = screen.getAllByRole('checkbox', { name: 'com_ui_select_row' });
  expect(rows[0]).toBeDisabled();
  expect(rows[0]).toHaveAccessibleDescription('com_files_retained_media');
  await user.click(screen.getByRole('checkbox', { name: 'com_ui_select_all' }));
  expect(rows[0]).not.toBeChecked();
  expect(rows[1]).toBeChecked();
  await user.click(screen.getByRole('button', { name: 'com_ui_delete' }));
  expect(mockDeleteFiles).toHaveBeenCalledWith(expect.objectContaining({ files: [ordinary] }));
});
