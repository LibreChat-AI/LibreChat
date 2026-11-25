import {
  beginPinnedDrag,
  endedOverExternalTarget,
  markExternalHover,
  markPinnedHover,
  mergeVisibleOrder,
  shouldSwapOnHover,
} from '../dnd';

/** A 36px favorite row and a 48px chat row, the two heights the pinned list
 *  mixes below the `md` breakpoint. */
const row = (top: number, height: number) => ({ hoverTop: top, hoverBottom: top + height });

describe('shouldSwapOnHover', () => {
  it('refuses a hover on the row being dragged', () => {
    expect(shouldSwapOnHover({ dragIndex: 1, hoverIndex: 1, pointerY: 50, ...row(36, 48) })).toBe(
      false,
    );
  });

  it('refuses a hover on a row the list no longer holds', () => {
    expect(shouldSwapOnHover({ dragIndex: -1, hoverIndex: 2, pointerY: 50, ...row(36, 48) })).toBe(
      false,
    );
    expect(shouldSwapOnHover({ dragIndex: 0, hoverIndex: -1, pointerY: 50, ...row(36, 48) })).toBe(
      false,
    );
  });

  it('waits for the midpoint when dragging downwards', () => {
    expect(shouldSwapOnHover({ dragIndex: 0, hoverIndex: 1, pointerY: 40, ...row(36, 48) })).toBe(
      false,
    );
    expect(shouldSwapOnHover({ dragIndex: 0, hoverIndex: 1, pointerY: 62, ...row(36, 48) })).toBe(
      true,
    );
  });

  it('waits for the midpoint when dragging upwards', () => {
    expect(shouldSwapOnHover({ dragIndex: 2, hoverIndex: 1, pointerY: 80, ...row(36, 48) })).toBe(
      false,
    );
    expect(shouldSwapOnHover({ dragIndex: 2, hoverIndex: 1, pointerY: 40, ...row(36, 48) })).toBe(
      true,
    );
  });

  it('does not oscillate once a shorter row has displaced a taller one', () => {
    /* A 36px row dragged onto a 48px row below it. Before the swap the rows sit
     * at 0-36 and 36-84; a pointer at y=40 is inside the taller row's top half,
     * so nothing moves. Swapping there would put the taller row at 0-48, still
     * under the same pointer, and the next hover would swap it straight back. */
    expect(shouldSwapOnHover({ dragIndex: 0, hoverIndex: 1, pointerY: 40, ...row(36, 48) })).toBe(
      false,
    );
    /* After a swap that did clear the midpoint, the displaced row occupies
     * 0-48 and the pointer that caused it sits past its midpoint, which reads
     * as "already ahead of this row" rather than as a reason to swap back. */
    expect(shouldSwapOnHover({ dragIndex: 1, hoverIndex: 0, pointerY: 62, ...row(0, 48) })).toBe(
      false,
    );
  });
});

describe('mergeVisibleOrder', () => {
  it('replaces the whole order when everything is visible', () => {
    expect(mergeVisibleOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('keeps hidden keys in place when only part of the list is visible', () => {
    /* `b` and `d` are filtered out of view. Reordering the visible `a`, `c`, `e`
     * must not drop them, which is what persisting the visible list alone did. */
    const stored = ['a', 'b', 'c', 'd', 'e'];
    expect(mergeVisibleOrder(stored, ['e', 'c', 'a'])).toEqual(['e', 'b', 'c', 'd', 'a']);
  });

  it('appends visible keys the stored order does not know', () => {
    expect(mergeVisibleOrder(['a', 'b'], ['b', 'a', 'new'])).toEqual(['b', 'a', 'new']);
  });

  it('drops nothing when the stored order is empty', () => {
    expect(mergeVisibleOrder([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('keeps every hidden key when only one row is visible', () => {
    expect(mergeVisibleOrder(['a', 'b', 'c'], ['c'])).toEqual(['a', 'b', 'c']);
  });

  /* The section reads a stored order back grouped, so an order saved before the
   * kinds were kept apart is normalized here rather than merged across. Here
   * `convo:hidden` is a pinned chat the drained list has not delivered yet:
   * swapping the two visible chats must leave it where it was among chats,
   * second of three. */
  it('keeps each kind in its own slots when a legacy order interleaves them', () => {
    const stored = ['convo:c1', 'convo:hidden', 'model:1:A:m', 'convo:c2'];
    const visible = ['model:1:A:m', 'convo:c2', 'convo:c1'];

    const merged = mergeVisibleOrder(stored, visible);

    expect(merged).toEqual(['model:1:A:m', 'convo:c2', 'convo:hidden', 'convo:c1']);
    expect(merged.filter((key) => key.startsWith('convo:'))).toEqual([
      'convo:c2',
      'convo:hidden',
      'convo:c1',
    ]);
  });
});

/* `didDrop()` is false both for a drop the pinned rows handled and for one an
 * external target refused, so the last target under the pointer is what
 * separates a deliberate reorder from a filing action that merely shifted the
 * rows it crossed. */
describe('drag target tracking', () => {
  beforeEach(() => {
    beginPinnedDrag();
  });

  it('treats a drag that never left the pinned rows as a reorder', () => {
    markPinnedHover();
    expect(endedOverExternalTarget()).toBe(false);
  });

  it('treats a drag ending on a project row as external, refused or not', () => {
    markPinnedHover();
    markExternalHover();
    expect(endedOverExternalTarget()).toBe(true);
  });

  it('treats a drag that strayed out and came back as a reorder', () => {
    markPinnedHover();
    markExternalHover();
    markPinnedHover();
    expect(endedOverExternalTarget()).toBe(false);
  });

  /* Hovering the dragged row itself is a no-op for ordering but still says the
   * pointer is inside the list, so a drag that wandered onto a project and came
   * back to its own position is a reorder, not a filing action. */
  it('counts a return to the dragged row as being back inside the list', () => {
    markPinnedHover();
    markExternalHover();
    /* The row's hover fires for its own key too, before the no-op guard. */
    markPinnedHover();
    expect(endedOverExternalTarget()).toBe(false);
  });

  /* The header and the padding around the rows belong to the list too, so
   * coming to rest on one of them is a return, not a departure. */
  it('counts a return anywhere inside the section as being back inside', () => {
    markPinnedHover();
    markExternalHover();
    /* The section's own hover fires where no row does. */
    markPinnedHover();
    expect(endedOverExternalTarget()).toBe(false);
  });

  it('starts each drag with no external hover carried over', () => {
    markExternalHover();
    beginPinnedDrag();
    expect(endedOverExternalTarget()).toBe(false);
  });
});
