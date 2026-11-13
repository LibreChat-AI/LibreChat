import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { useReactTable, getCoreRowModel } from '@tanstack/react-table';
import type { VisibilityState } from '@tanstack/react-table';
import type { MenuItemProps } from '@librechat/client';
import { ColumnVisibilityDropdown } from '../ColumnVisibilityDropdown';

const localize = (key: string) => key;
const contextMap = { filename: 'com_ui_name' } as const;

jest.mock('~/hooks', () => ({
  useLocalize: () => localize,
}));

jest.mock('@ariakit/react/menu', () => ({
  MenuButton: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('@librechat/client', () => ({
  DropdownPopup: ({
    trigger,
    items,
    isOpen,
    setIsOpen,
  }: {
    trigger: React.ReactNode;
    items: MenuItemProps[];
    isOpen: boolean;
    setIsOpen: (isOpen: boolean) => void;
  }) => (
    <div>
      <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>
      {isOpen &&
        items.map((item) => (
          <button
            key={item.id}
            role="menuitemcheckbox"
            aria-label={item.label}
            aria-checked={item.ariaChecked}
            onClick={(event) => {
              item.onClick?.(event);
              setIsOpen(false);
            }}
          >
            <span>{item.icon}</span>
            {item.label}
          </button>
        ))}
    </div>
  ),
}));

function Harness({ isSmallScreen = false }: { isSmallScreen?: boolean }) {
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const table = useReactTable({
    data: [] as { filename: string }[],
    columns: [{ accessorKey: 'filename' }],
    getCoreRowModel: getCoreRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    state: { columnVisibility },
  });

  return (
    <>
      <output data-testid="filename-visibility">
        {table.getColumn('filename')?.getIsVisible() ? 'visible' : 'hidden'}
      </output>
      <ColumnVisibilityDropdown
        table={table}
        contextMap={contextMap}
        isSmallScreen={isSmallScreen}
      />
    </>
  );
}

describe('ColumnVisibilityDropdown', () => {
  it('updates the checkmark when a column is hidden and shown again', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'com_files_filter_by' });
    await user.click(trigger);

    let nameOption = screen.getByRole('menuitemcheckbox', { name: 'com_ui_name' });
    expect(within(nameOption).getByText('✓')).toBeInTheDocument();
    expect(nameOption).toHaveAttribute('aria-checked', 'true');

    await user.click(nameOption);
    expect(screen.getByTestId('filename-visibility')).toHaveTextContent('hidden');
    await user.click(trigger);

    nameOption = screen.getByRole('menuitemcheckbox', { name: 'com_ui_name' });
    expect(within(nameOption).queryByText('✓')).not.toBeInTheDocument();
    expect(nameOption).toHaveAttribute('aria-checked', 'false');

    await user.click(nameOption);
    expect(screen.getByTestId('filename-visibility')).toHaveTextContent('visible');
    await user.click(trigger);

    nameOption = screen.getByRole('menuitemcheckbox', { name: 'com_ui_name' });
    expect(within(nameOption).getByText('✓')).toBeInTheDocument();
    expect(nameOption).toHaveAttribute('aria-checked', 'true');
  });

  it('uses compact trigger spacing on small screens', () => {
    render(<Harness isSmallScreen />);

    expect(screen.getByRole('button', { name: 'com_files_filter_by' })).toHaveClass('px-2', 'py-1');
  });
});
