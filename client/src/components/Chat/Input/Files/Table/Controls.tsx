import { useId, useMemo, useState } from 'react';
import { MenuButton } from '@ariakit/react';
import { ArrowUpDown, ListFilter } from 'lucide-react';
import { Button, DropdownPopup } from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import type { Table } from '@tanstack/react-table';
import type { MenuItemProps } from '~/common';
import { useLocalize } from '~/hooks';
import { labels } from './labels';

function Menu({
  title,
  items,
  icon,
}: {
  title: string;
  items: MenuItemProps[];
  icon: React.ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <DropdownPopup
      menuId={id}
      isOpen={open}
      setIsOpen={setOpen}
      items={items}
      trigger={
        <MenuButton render={<Button variant="outline" size="sm" />}>
          {icon}
          {title}
        </MenuButton>
      }
    />
  );
}

export function Controls({ table }: { table: Table<TFile> }) {
  const localize = useLocalize();
  const filters = table.getState().columnFilters.filter((filter) => filter.id !== 'filename');
  const data = table.options.data;
  const choices = useMemo(
    () => ({
      source: [...new Set(data.map((file) => file.source).filter((value) => value != null))].sort(),
      context: [
        ...new Set(data.map((file) => file.context).filter((value) => value != null)),
      ].sort(),
    }),
    [data],
  );
  const options = (id: 'source' | 'context', title: string): MenuItemProps[] => {
    const column = table.getColumn(id);
    const values = choices[id];
    return [
      { label: title, disabled: true },
      ...values.map((value) => {
        const key = labels[value];
        const label = key ? localize(key) : value;
        return {
          label,
          ariaLabel: label,
          ariaChecked: column?.getFilterValue() === value,
          onClick: () =>
            column?.setFilterValue(column.getFilterValue() === value ? undefined : value),
        };
      }),
    ];
  };
  const filterItems = [
    ...options('source', localize('com_ui_storage')),
    ...options('context', localize('com_ui_context')),
    {
      label: localize('com_ui_clear_filters'),
      disabled: !filters.length,
      onClick: () =>
        table.setColumnFilters((old) => old.filter((filter) => filter.id === 'filename')),
    },
  ];
  const sort = table.getState().sorting[0];
  const sortItems = [
    { id: 'updatedAt', desc: true, label: localize('com_ui_sort_newest') },
    { id: 'updatedAt', desc: false, label: localize('com_ui_sort_oldest') },
    { id: 'filename', desc: false, label: localize('com_ui_sort_a_z') },
    { id: 'filename', desc: true, label: localize('com_ui_sort_z_a') },
    { id: 'bytes', desc: true, label: localize('com_files_largest_first') },
    { id: 'bytes', desc: false, label: localize('com_files_smallest_first') },
  ].map(
    ({ id, desc, label }): MenuItemProps => ({
      id: id + String(desc),
      label,
      ariaLabel: label,
      ariaChecked: sort?.id === id && sort.desc === desc,
      ariaRole: 'menuitemradio',
      onClick: () => table.setSorting([{ id, desc }]),
    }),
  );
  return (
    <>
      <Menu
        title={
          filters.length
            ? localize('com_ui_filters_active', { count: filters.length })
            : localize('com_files_filters')
        }
        icon={<ListFilter aria-hidden="true" className="size-4" />}
        items={filterItems}
      />
      <Menu
        title={localize('com_ui_sort')}
        icon={<ArrowUpDown aria-hidden="true" className="size-4" />}
        items={sortItems}
      />
    </>
  );
}
