import { act, renderHook, waitFor } from '@testing-library/react';
import useLazyHighlight from '../useLazyHighlight';

/** Real grammars, behind spies, so the count of tokenizations is observable. */
const mockHighlightCalls: string[] = [];

jest.mock('lowlight', () => {
  const actual = jest.requireActual('lowlight');
  return {
    ...actual,
    lowlight: {
      registered: (lang: string) => actual.lowlight.registered(lang),
      highlight: (lang: string, code: string) => {
        mockHighlightCalls.push(lang);
        return actual.lowlight.highlight(lang, code);
      },
      highlightAuto: (code: string) => {
        mockHighlightCalls.push('auto');
        return actual.lowlight.highlightAuto(code);
      },
    },
  };
});

const CODE = "const greeting = 'hello';\nconsole.log(greeting);\n";
const OTHER_CODE = 'print("hello")\n';

/** Renders the hook the way a tool card does, with the pane's open state deciding the input. */
function renderHighlight(code: string | undefined, lang = 'javascript') {
  return renderHook(
    ({ code: current, lang: currentLang }: { code: string | undefined; lang: string }) =>
      useLazyHighlight(current, currentLang),
    { initialProps: { code, lang } },
  );
}

/** Lets the grammars finish loading and any queued effect settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Loads the grammars once, as the first opened card in a session does. */
async function warmGrammars() {
  const warm = renderHighlight(CODE);
  await waitFor(() => expect(warm.result.current).not.toBeNull());
  warm.unmount();
  mockHighlightCalls.length = 0;
}

describe('useLazyHighlight', () => {
  beforeEach(() => {
    mockHighlightCalls.length = 0;
  });

  it('holds nothing, and tokenizes nothing, while its caller passes no code', async () => {
    const { result } = renderHighlight(undefined);

    expect(result.current).toBeNull();
    await settle();
    expect(result.current).toBeNull();
    expect(mockHighlightCalls).toEqual([]);
  });

  it('highlights once the grammars have loaded', async () => {
    const { result } = renderHighlight(CODE);

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.length).toBeGreaterThan(0);
  });

  it('tokenizes one input once, not once per render', async () => {
    /* The grammars stay loaded for the rest of the session, so a card opened later can highlight
     * during its first render. Repeating that in the effect that follows costs a second
     * tokenization and a second commit for every card the reader opens. */
    await warmGrammars();

    const { result, rerender } = renderHighlight(CODE);
    expect(result.current).not.toBeNull();

    await settle();
    rerender({ code: CODE, lang: 'javascript' });
    await settle();

    expect(mockHighlightCalls).toHaveLength(1);
  });

  it('tokenizes nothing for a card whose pane is closed', async () => {
    await warmGrammars();

    const { result, rerender } = renderHighlight(undefined);
    rerender({ code: undefined, lang: 'javascript' });
    await settle();

    expect(result.current).toBeNull();
    expect(mockHighlightCalls).toEqual([]);
  });

  it('highlights when the pane opens, and drops what it holds when it closes', async () => {
    await warmGrammars();
    const { result, rerender } = renderHighlight(undefined);

    rerender({ code: CODE, lang: 'javascript' });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(mockHighlightCalls).toHaveLength(1);

    rerender({ code: undefined, lang: 'javascript' });
    await settle();
    expect(result.current).toBeNull();
  });

  it('highlights again when the code changes', async () => {
    const { result, rerender } = renderHighlight(CODE);
    await waitFor(() => expect(result.current).not.toBeNull());
    const first = result.current;

    rerender({ code: OTHER_CODE, lang: 'python' });
    await waitFor(() => expect(result.current).not.toBe(first));
    expect(result.current?.length).toBeGreaterThan(0);
  });
});
