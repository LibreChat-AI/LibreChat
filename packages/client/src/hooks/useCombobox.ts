import { SetStateAction, Dispatch, useMemo, useState } from 'react';
import { matchSorter } from 'match-sorter';
import type { OptionWithIcon, MentionOption } from '~/common';

export default function useCombobox({
  value,
  options,
}: {
  value: string;
  options: Array<OptionWithIcon | MentionOption>;
}): {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  searchValue: string;
  setSearchValue: Dispatch<SetStateAction<string>>;
  matches: (OptionWithIcon | MentionOption)[];
} {
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');

  const matches = useMemo(() => {
    if (!searchValue) {
      return options;
    }
    const keys = ['label', 'value'];
    const matches = matchSorter(options, searchValue, { keys });
    // Radix Select does not work if we don't render the selected item, so we
    // make sure to include it in the list of matches.
    const selectedItem = options.find((currentItem) => currentItem.value === value);
    if (selectedItem && !matches.includes(selectedItem)) {
      matches.push(selectedItem);
    }
    return matches;
  }, [searchValue, value, options]);

  return {
    open,
    setOpen,
    searchValue,
    setSearchValue,
    matches,
  };
}
