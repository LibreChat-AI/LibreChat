import { cn, buttonVariants } from '@librechat/client';
import { revealOnRowHoverClasses } from '../styles';

const FADE = 'no-touch:opacity-0';

/** The row-wide keyboard-focus condition, as two variants. It cannot be one
 *  `group-[&:is(...)]`: that form makes Tailwind emit a bare `.group$` rule
 *  that lightningcss rejects, which fails the production CSS build. */
const FOCUS_SELF = 'group-focus-visible';
const FOCUS_DESCENDANT = 'group-has-[:focus-visible:not(:is(input,textarea,[contenteditable]))]';

describe('revealOnRowHoverClasses', () => {
  it('reveals on row hover and on keyboard focus', () => {
    expect(revealOnRowHoverClasses).toContain(FADE);
    expect(revealOnRowHoverClasses).toContain('group-hover:opacity-100');
    expect(revealOnRowHoverClasses).toContain(`${FOCUS_DESCENDANT}:opacity-100`);
  });

  /* Clicking a tool card in the message body parks focus there. `:focus-within`
     would hold the footer open with the pointer nowhere near the row. */
  it('does not reveal on plain focus-within', () => {
    expect(revealOnRowHoverClasses).not.toContain('group-focus-within:');
  });

  /* MessageNav moves the reader by focusing the row itself through
     tabindex="-1", and :has() never matches its own subject. */
  it('reveals when the row element itself is focus-visible', () => {
    expect(revealOnRowHoverClasses).toContain(`${FOCUS_SELF}:opacity-100`);
  });

  /* Text-entry controls match :focus-visible even on a mouse click, and
     ToolApproval and AskUserQuestion both render textareas inside a row. */
  it('ignores focus that landed in a text-entry control', () => {
    expect(revealOnRowHoverClasses).toContain(':not(:is(input,textarea,[contenteditable]))');
  });

  /* A bare `.group$` rule in the emitted CSS fails the lightningcss minify
     step, so the variant form itself is worth pinning. */
  it('does not use a group-[&:...] variant', () => {
    expect(revealOnRowHoverClasses).not.toContain('group-[&');
  });

  it('fades on the shared motion role rather than snapping', () => {
    expect(revealOnRowHoverClasses).toContain('duration-theme-normal');
    expect(revealOnRowHoverClasses).toContain('ease-out');
    expect(revealOnRowHoverClasses).toContain('motion-reduce:transition-none');
  });

  /* The hover tint snaps: only opacity transitions, and the reveal replaces the
     `transition-none` the toolbar buttons carry. */
  it('transitions opacity only', () => {
    expect(revealOnRowHoverClasses).toContain('transition-opacity');
    expect(revealOnRowHoverClasses).not.toContain('transition-reveal');
  });

  it('does not fade colours when merged onto a Button', () => {
    const merged = cn(buttonVariants({ variant: 'message-hover-reveal' }));
    expect(merged).toContain('transition-opacity');
    expect(merged).not.toContain('transition-colors');
    expect(cn(buttonVariants({ variant: 'message-hover' }))).toContain('transition-none');
  });
});

describe('message hover buttons', () => {
  const idle = buttonVariants({ variant: 'message-hover-reveal' });
  const last = buttonVariants({ variant: 'message-hover' });

  it('fades an idle action out until the row is hovered', () => {
    expect(idle).toContain(FADE);
    expect(idle).toContain('group-hover:opacity-100');
  });

  it('reveals an idle action on keyboard focus, not on a click parking focus in the row', () => {
    expect(idle).toContain(`${FOCUS_DESCENDANT}:opacity-100`);
    expect(idle).not.toContain('group-focus-within:');
  });

  it('marks an active action so the toolbar can key off it', () => {
    expect(idle).toContain('data-[hover-active]:bg-surface-hover');
    expect(idle).toContain('data-[hover-active]:text-text-primary');
  });

  it('keeps every action opaque while any of them is active', () => {
    expect(idle).toContain('group-has-[[data-hover-active]]:opacity-100');
    expect(last).toContain('group-has-[[data-hover-active]]:opacity-100');
  });

  it('does not use the legacy active class as the marker', () => {
    expect(idle).not.toContain('group-has-[.active]');
    expect(last).not.toContain('group-has-[.active]');
  });

  it('never fades the actions on the last row', () => {
    expect(last).not.toContain(FADE);
  });

  it('keeps the marker the narrow-screen stylesheet reads', () => {
    expect(idle).toContain('hover-button');
    expect(last).toContain('hover-button');
  });
});
