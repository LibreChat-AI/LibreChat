import type { WorkSheet, utils as SheetUtils } from 'xlsx';

/**
 * Shrinks a worksheet's declared range (`!ref`) so it ends at the last cell holding a value or a
 * formula, keeping its original top-left corner. Excel widens the range to whole columns or rows
 * when formatting spans them (e.g. `A1:Z1048576`); SheetJS serializers walk every cell of that
 * range, so a few-KB workbook would otherwise render megabytes of empty cells or exceed the
 * traversal limits. Only ever shrinks: an inverted range is left for the caller to reject, and
 * cells outside the declared range are ignored. Removes `!ref` when the range holds no content.
 */
export function trimSheetRange(worksheet: WorkSheet, utils: typeof SheetUtils): void {
  const ref = worksheet['!ref'];
  if (!ref) {
    return;
  }
  const { s, e } = utils.decode_range(ref);
  if (e.r < s.r || e.c < s.c) {
    return;
  }
  let maxRow = -1;
  let maxCol = -1;
  for (const address of Object.keys(worksheet)) {
    if (address.startsWith('!')) {
      continue;
    }
    const cell = worksheet[address];
    const hasValue = cell?.v != null && cell.v !== '';
    if (!hasValue && cell?.f == null) {
      continue;
    }
    const { r, c } = utils.decode_cell(address);
    if (r < s.r || r > e.r || c < s.c || c > e.c) {
      continue;
    }
    maxRow = Math.max(maxRow, r);
    maxCol = Math.max(maxCol, c);
  }
  if (maxRow < 0) {
    delete worksheet['!ref'];
    return;
  }
  worksheet['!ref'] = utils.encode_range({ s, e: { r: maxRow, c: maxCol } });
}
