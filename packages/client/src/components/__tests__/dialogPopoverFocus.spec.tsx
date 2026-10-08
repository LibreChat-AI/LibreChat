import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../Select';
import { OGDialog, OGDialogContent } from '../OriginalDialog';

/**
 * A dialog traps focus, and a popover opened inside it is expected to take that
 * trap over — Radix does this by pausing the outer scope when the inner one
 * mounts. Both scopes have to come from the same copy of
 * `@radix-ui/react-focus-scope` for that hand-off to happen; with duplicates,
 * the dialog never yields and the popover's options cannot be reached by
 * keyboard. `radixLayers.spec.ts` pins the packaging invariant; this asserts
 * the behaviour it exists for.
 */
it('lets a portaled select option hold focus inside a dialog', () => {
  render(
    <OGDialog open>
      <OGDialogContent>
        <Select open value="ask">
          <SelectTrigger aria-label="Execution environment">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ask">Ask before changes</SelectItem>
            <SelectItem value="accept">Accept edits</SelectItem>
          </SelectContent>
        </Select>
      </OGDialogContent>
    </OGDialog>,
  );

  const option = screen.getByRole('option', { name: 'Accept edits' });
  option.focus();

  expect(document.activeElement).toBe(option);
});
