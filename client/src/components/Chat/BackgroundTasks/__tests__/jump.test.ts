import { waitFor } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import { recordFold } from '@librechat/chat/components';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { TaskRow } from '../rows';
import { visitTaskTarget } from '../jump';

const call = (id: string): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id, name: 'execute_code', args: '{}' },
  }) as TMessageContentParts;

const row = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  id: 'tool:task-1',
  kind: 'tool',
  name: 'execute_code',
  messageId: 'message-1',
  toolCallId: 'call-1',
  status: 'completed',
  ...overrides,
});

/** A call's own row, with the disclosure that shows what it ran. */
function toolRow(
  id: string,
  expanded = false,
): { element: HTMLElement; details: HTMLButtonElement } {
  const element = document.createElement('div');
  element.dataset.taskToolCall = id;
  element.scrollIntoView = jest.fn();
  const details = document.createElement('button');
  details.setAttribute('aria-expanded', String(expanded));
  details.addEventListener('click', () =>
    details.setAttribute('aria-expanded', String(details.getAttribute('aria-expanded') !== 'true')),
  );
  element.append(details);
  return { element, details };
}

/**
 * A fold as the thread draws one: a root that holds some parts, a header that opens it, and a
 * body that is not in the document until it is open. `body` arrives a frame after the click, as
 * rows mounted by a commit do.
 */
function fold(
  holds: string[],
  body: HTMLElement,
  open = false,
): { root: HTMLElement; toggle: HTMLButtonElement; clicks: () => number } {
  const root = document.createElement('div');
  root.setAttribute('data-fold-root', '');
  recordFold(root, holds.map(call));
  const toggle = document.createElement('button');
  toggle.setAttribute('data-fold-toggle', '');
  toggle.setAttribute('aria-expanded', String(open));
  let clicks = 0;
  toggle.addEventListener('click', () => {
    clicks += 1;
    const next = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(next));
    if (next) {
      requestAnimationFrame(() => root.append(body));
    } else {
      body.remove();
    }
  });
  root.append(toggle);
  if (open) {
    root.append(body);
  }
  return { root, toggle, clicks: () => clicks };
}

/**
 * A closed fold that still has its rows in the document, hidden: what the thread draws while a
 * fold's closing animation runs, and for as long as a fold closed over a pending approval keeps
 * its body. Its header opens it by showing the panel again.
 */
function heldFold(
  holds: string[],
  body: HTMLElement,
): { root: HTMLElement; toggle: HTMLButtonElement; panel: HTMLElement } {
  const root = document.createElement('div');
  root.setAttribute('data-fold-root', '');
  recordFold(root, holds.map(call));
  const toggle = document.createElement('button');
  toggle.setAttribute('data-fold-toggle', '');
  toggle.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div');
  panel.setAttribute('aria-hidden', 'true');
  panel.append(body);
  toggle.addEventListener('click', () => {
    const next = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(next));
    panel.setAttribute('aria-hidden', String(!next));
  });
  root.append(toggle, panel);
  return { root, toggle, panel };
}

function message(...children: HTMLElement[]): HTMLElement {
  const element = document.createElement('div');
  element.id = 'message-1';
  element.scrollIntoView = jest.fn();
  element.append(...children);
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('visitTaskTarget', () => {
  it('opens every closed fold around the call, then the call, and lands on it', async () => {
    const target = toolRow('call-1');
    const group = fold(['call-0', 'call-1'], target.element);
    const phase = fold(['call-0', 'call-1', 'call-2'], group.root);
    message(phase.root);
    const leave = jest.fn();

    expect(visitTaskTarget(row(), leave)).toBe(true);
    expect(leave).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(target.element.scrollIntoView).toHaveBeenCalled());
    expect(phase.toggle).toHaveAttribute('aria-expanded', 'true');
    expect(group.toggle).toHaveAttribute('aria-expanded', 'true');
    expect(target.details).toHaveAttribute('aria-expanded', 'true');
    expect(target.element).toHaveFocus();
    expect(phase.clicks()).toBe(1);
    expect(group.clicks()).toBe(1);
  });

  it('leaves alone a fold that is already open and a call that already shows its details', async () => {
    const target = toolRow('call-1', true);
    const group = fold(['call-1'], target.element, true);
    message(group.root);

    expect(visitTaskTarget(row())).toBe(true);

    await waitFor(() => expect(target.element.scrollIntoView).toHaveBeenCalled());
    expect(group.clicks()).toBe(0);
    expect(group.toggle).toHaveAttribute('aria-expanded', 'true');
    expect(target.details).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens only the folds that hold the call', async () => {
    const target = toolRow('call-1');
    const mine = fold(['call-1'], target.element);
    const other = fold(['call-9'], toolRow('call-9').element);
    message(other.root, mine.root);

    visitTaskTarget(row());

    await waitFor(() => expect(target.element.scrollIntoView).toHaveBeenCalled());
    expect(other.clicks()).toBe(0);
    expect(other.toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a closed fold whose rows are still in the document, hidden', async () => {
    const target = toolRow('call-1');
    const group = heldFold(['call-0', 'call-1'], target.element);
    message(group.root);
    const leave = jest.fn();

    expect(visitTaskTarget(row(), leave)).toBe(true);
    expect(leave).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(target.element.scrollIntoView).toHaveBeenCalled());
    expect(group.toggle).toHaveAttribute('aria-expanded', 'true');
    expect(target.details).toHaveAttribute('aria-expanded', 'true');
    expect(target.element).toHaveFocus();
  });

  it('opens a hidden fold inside a fold that has not drawn its rows', async () => {
    const target = toolRow('call-1');
    const group = heldFold(['call-1'], target.element);
    const phase = fold(['call-1', 'call-2'], group.root);
    message(phase.root);

    expect(visitTaskTarget(row())).toBe(true);

    await waitFor(() => expect(target.element.scrollIntoView).toHaveBeenCalled());
    expect(phase.toggle).toHaveAttribute('aria-expanded', 'true');
    expect(group.toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('says there is nowhere to go when the message itself is hidden', () => {
    const target = toolRow('call-1');
    const element = message(heldFold(['call-1'], target.element).root);
    const pane = document.createElement('div');
    pane.setAttribute('inert', '');
    document.body.append(pane);
    pane.append(element);
    const leave = jest.fn();

    expect(visitTaskTarget(row(), leave)).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });

  it('says there is nowhere to go when the call is hidden by something no fold explains', () => {
    const target = toolRow('call-1');
    const hidden = document.createElement('div');
    hidden.setAttribute('aria-hidden', 'true');
    hidden.append(target.element);
    message(hidden);

    expect(visitTaskTarget(row())).toBe(false);
  });

  it('settles on the message when the call is drawn nowhere in it', async () => {
    const element = message();

    expect(visitTaskTarget(row())).toBe(true);

    await waitFor(() => expect(element.scrollIntoView).toHaveBeenCalled());
    expect(element).toHaveFocus();
  });

  it('gives up on a fold that will not open instead of pressing it again', async () => {
    const stuck = document.createElement('div');
    stuck.setAttribute('data-fold-root', '');
    recordFold(stuck, [call('call-1')]);
    const toggle = document.createElement('button');
    toggle.setAttribute('data-fold-toggle', '');
    toggle.setAttribute('aria-expanded', 'false');
    const pressed = jest.fn();
    toggle.addEventListener('click', pressed);
    stuck.append(toggle);
    const element = message(stuck);

    visitTaskTarget(row());

    await waitFor(() => expect(element.scrollIntoView).toHaveBeenCalled());
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it('says there is nowhere to go when the message is not among those loaded', () => {
    const leave = jest.fn();
    expect(visitTaskTarget(row(), leave)).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });
});
