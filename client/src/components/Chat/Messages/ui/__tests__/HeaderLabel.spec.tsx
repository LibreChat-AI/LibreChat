import { render, screen } from '@testing-library/react';
import HeaderLabel, { getHeaderHoverLabel, getHeaderModelName } from '../HeaderLabel';

describe('getHeaderModelName', () => {
  it('prefers a real model over an agent document id', () => {
    expect(getHeaderModelName('agent_abc', 'gemma4:12b-it-qat')).toBe('gemma4:12b-it-qat');
  });

  it('returns nothing when only an agent id is available', () => {
    expect(getHeaderModelName('agent_abc')).toBeUndefined();
  });

  /* An Assistants-endpoint message keys the assistant map by `assistant.id`, so
     its `model` field holds an `asst_` id rather than a model name. */
  it('prefers a real model over an assistant document id', () => {
    expect(getHeaderModelName(undefined, 'gpt-4o', 'asst_abc')).toBe('gpt-4o');
  });

  it('returns nothing when only an assistant id is available', () => {
    expect(getHeaderModelName(undefined, undefined, 'asst_abc')).toBeUndefined();
  });
});

describe('getHeaderHoverLabel', () => {
  it('falls through to the model when the sender is not a configured label', () => {
    expect(getHeaderHoverLabel(false, 'agent_abc', 'gemma4:12b-it-qat')).toBe('gemma4:12b-it-qat');
    expect(getHeaderHoverLabel(undefined, 'gemma4:12b-it-qat')).toBe('gemma4:12b-it-qat');
  });

  /* A preset or model spec that configured the sender has chosen what the header
     says; the hover swap must not reveal the model it stands in for. */
  it('withholds the model when the sender is a configured label', () => {
    expect(getHeaderHoverLabel(true, 'z-ai/glm-5.3-flash')).toBeUndefined();
    expect(getHeaderHoverLabel(true, 'agent_abc', 'z-ai/glm-5.3-flash')).toBeUndefined();
  });
});

describe('HeaderLabel', () => {
  it('renders only the provider when there is no model to show', () => {
    render(<HeaderLabel label="Ollama" />);

    expect(screen.getByText('Ollama')).toBeVisible();
    expect(screen.queryByText('gemma4:12b-it-qat')).not.toBeInTheDocument();
  });

  it('keeps the model in the slot for a hover swap', () => {
    render(<HeaderLabel label="Ollama" hoverLabel="gemma4:12b-it-qat" />);

    expect(screen.getByText('Ollama')).toBeVisible();
    expect(screen.getByText('gemma4:12b-it-qat')).toHaveAttribute('aria-hidden', 'true');
  });

  /* A pointer swap alone would strand a sighted keyboard user, who reaches the
     row by focus. `.message-render` carries the `group` this keys off. */
  it('also swaps the model in when the message row takes keyboard focus', () => {
    render(<HeaderLabel label="Ollama" hoverLabel="gemma4:12b-it-qat" />);

    const self = 'group-focus-visible';
    const descendant = 'group-has-[:focus-visible:not(:is(input,textarea,[contenteditable]))]';

    const provider = screen.getByText('Ollama').className;
    const model = screen.getByText('gemma4:12b-it-qat').className;

    expect(provider).toContain(`${self}:opacity-0`);
    expect(provider).toContain(`${descendant}:opacity-0`);
    expect(model).toContain(`${self}:opacity-100`);
    expect(model).toContain(`${descendant}:opacity-100`);
  });

  /* Clicking a tool card inside the row leaves focus on it. `:focus-within`
     would hold the model in place with the pointer nowhere near the row. */
  it('does not key the swap off plain focus-within', () => {
    render(<HeaderLabel label="Ollama" hoverLabel="gemma4:12b-it-qat" />);

    expect(screen.getByText('Ollama').className).not.toContain('group-focus-within:');
    expect(screen.getByText('gemma4:12b-it-qat').className).not.toContain('group-focus-within:');
  });

  /* Screen readers never move the visual focus, so the model also has to reach
     assistive tech through text that is never hidden. */
  it('names the model in text that does not depend on hover', () => {
    render(<HeaderLabel label="Ollama" hoverLabel="gemma4:12b-it-qat" />);

    const announced = screen.getByText('Model: gemma4:12b-it-qat');

    expect(announced).toHaveClass('sr-only');
    expect(announced).not.toHaveAttribute('aria-hidden');
  });
});
