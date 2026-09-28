import { RecoilRoot } from 'recoil';
import copy from 'copy-to-clipboard';
import { renderHook, act } from '@testing-library/react';
import type { MutableSnapshot } from 'recoil';
import type { ReactNode } from 'react';
import type { MarkdownVariant } from '~/utils/richtext';
import { useCopyMessageToClipboard } from '~/hooks/Messages/useCopyToClipboard';
import store from '~/store';

jest.mock('copy-to-clipboard');

describe('useCopyMessageToClipboard', () => {
  const TEXT = '$E=mc^2$';
  const mockSetIsCopied = jest.fn();
  const mockCopy = copy as jest.MockedFunction<typeof copy>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCopy.mockReturnValue(true);
  });

  const renderWithSettings = (
    settings: { copyRichText: boolean; enableUserMsgMarkdown: boolean; latexParsing?: boolean },
    isCreatedByUser: boolean,
    variant?: MarkdownVariant,
    error?: boolean,
  ) => {
    const initializeState = ({ set }: MutableSnapshot) => {
      set(store.copyRichText, settings.copyRichText);
      set(store.enableUserMsgMarkdown, settings.enableUserMsgMarkdown);
      set(store.LaTeXParsing, settings.latexParsing ?? true);
    };

    return renderHook(
      () => useCopyMessageToClipboard({ text: TEXT, isCreatedByUser, variant, error }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <RecoilRoot initializeState={initializeState}>{children}</RecoilRoot>
        ),
      },
    );
  };

  const copiedAsHtml = (): boolean => {
    const [, options] = mockCopy.mock.calls[0];
    return options?.onCopy != null;
  };

  const copiedHtml = (): string => {
    const [, options] = mockCopy.mock.calls[0];
    const clipboardData = { setData: jest.fn() };
    options?.onCopy?.(clipboardData);
    return (clipboardData.setData.mock.calls[0]?.[1] ?? '') as string;
  };

  it('copies an assistant message as html when the preference is on', () => {
    const { result } = renderWithSettings(
      { copyRichText: true, enableUserMsgMarkdown: false },
      false,
    );

    act(() => {
      result.current(mockSetIsCopied);
    });

    expect(copiedAsHtml()).toBe(true);
  });

  it('keeps a user message plain when its markdown rendering is off', () => {
    const { result } = renderWithSettings(
      { copyRichText: true, enableUserMsgMarkdown: false },
      true,
    );

    act(() => {
      result.current(mockSetIsCopied);
    });

    expect(copiedAsHtml()).toBe(false);
  });

  it('copies a user message as html once its markdown rendering is on', () => {
    const { result } = renderWithSettings(
      { copyRichText: true, enableUserMsgMarkdown: true },
      true,
    );

    act(() => {
      result.current(mockSetIsCopied);
    });

    expect(copiedAsHtml()).toBe(true);
  });

  it('mirrors MarkdownLite for a user message, which has no directives', () => {
    const initializeState = ({ set }: MutableSnapshot) => {
      set(store.copyRichText, true);
      set(store.enableUserMsgMarkdown, true);
    };
    const { result } = renderHook(
      () => useCopyMessageToClipboard({ text: ':::warning\ntext\n:::', isCreatedByUser: true }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <RecoilRoot initializeState={initializeState}>{children}</RecoilRoot>
        ),
      },
    );

    act(() => {
      result.current(mockSetIsCopied);
    });

    expect(copiedHtml()).toBe('<p>:::warning<br />text<br />:::</p>');
  });

  it('mirrors Markdown for an assistant message, which unwraps directives', () => {
    const initializeState = ({ set }: MutableSnapshot) => {
      set(store.copyRichText, true);
      set(store.enableUserMsgMarkdown, true);
    };
    const { result } = renderHook(
      () => useCopyMessageToClipboard({ text: ':::warning\ntext\n:::', isCreatedByUser: false }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <RecoilRoot initializeState={initializeState}>{children}</RecoilRoot>
        ),
      },
    );

    act(() => {
      result.current(mockSetIsCopied);
    });

    expect(copiedHtml()).toBe('<p>text</p>');
  });

  it('follows the LaTeX parsing setting for assistant messages', () => {
    const withLatex = renderWithSettings(
      { copyRichText: true, enableUserMsgMarkdown: false, latexParsing: true },
      false,
    );

    act(() => {
      withLatex.result.current(mockSetIsCopied);
    });

    expect(copiedHtml()).toBe('<p>E=mc^2</p>');

    jest.clearAllMocks();
    mockCopy.mockReturnValue(true);

    const withoutLatex = renderWithSettings(
      { copyRichText: true, enableUserMsgMarkdown: false, latexParsing: false },
      false,
    );

    act(() => {
      withoutLatex.result.current(mockSetIsCopied);
    });

    expect(copiedHtml()).toBe('<p>$E=mc^2$</p>');
  });

  it('honors a forced variant over the authorship default', () => {
    const { result } = renderWithSettings(
      { copyRichText: true, enableUserMsgMarkdown: false, latexParsing: true },
      true,
      'lite',
    );

    act(() => {
      result.current(mockSetIsCopied);
    });

    expect(copiedAsHtml()).toBe(true);
    expect(copiedHtml()).toBe('<p>$E=mc^2$</p>');
  });

  it('stays plain for an errored row, which ErrorMessage renders instead', () => {
    const { result } = renderWithSettings(
      { copyRichText: true, enableUserMsgMarkdown: true },
      false,
      undefined,
      true,
    );

    act(() => {
      result.current(mockSetIsCopied);
    });

    expect(copiedAsHtml()).toBe(false);
  });

  it('stays plain for every author when the preference is off', () => {
    const { result } = renderWithSettings(
      { copyRichText: false, enableUserMsgMarkdown: true },
      false,
    );

    act(() => {
      result.current(mockSetIsCopied);
    });

    expect(copiedAsHtml()).toBe(false);
  });
});
