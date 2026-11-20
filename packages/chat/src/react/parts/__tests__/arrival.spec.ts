/** @jest-environment jsdom */
import { composerTextareaId } from '../../../core/composer';
import { isFocusIdle } from '../arrival';

/** A pane as the page draws one: its thread, where a question arrives, and its composer. */
function pane(index: number) {
  const element = document.createElement('div');
  element.dataset.chatPane = String(index);
  const question = document.createElement('div');
  const composer = document.createElement('textarea');
  composer.id = composerTextareaId(index);
  element.append(question, composer);
  document.body.appendChild(element);
  return { question, composer };
}

describe('isFocusIdle', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('takes focus that is nowhere', () => {
    const main = pane(0);
    expect(isFocusIdle(main.question)).toBe(true);
  });

  it('takes the empty composer of the pane the question arrived in', () => {
    const main = pane(0);
    const beside = pane(3);

    main.composer.focus();
    expect(isFocusIdle(main.question)).toBe(true);
    beside.composer.focus();
    expect(isFocusIdle(beside.question)).toBe(true);
  });

  it("leaves the reader in another pane's composer, empty or not", () => {
    const main = pane(0);
    const beside = pane(3);

    /** Writing to the conversation beside the chat when main chat's question arrives. */
    beside.composer.focus();
    expect(isFocusIdle(main.question)).toBe(false);
    main.composer.focus();
    expect(isFocusIdle(beside.question)).toBe(false);
  });

  it('leaves a composer the reader has started writing in', () => {
    const main = pane(0);
    main.composer.value = 'Wait';
    main.composer.focus();

    expect(isFocusIdle(main.question)).toBe(false);
  });

  it('leaves focus held by anything else', () => {
    const main = pane(0);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    expect(isFocusIdle(main.question)).toBe(false);
  });
});
