import React, { createRef } from 'react';
import { RecoilRoot } from 'recoil';
import { useForm, FormProvider } from 'react-hook-form';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import AskUserQuestionPopover from '../AskUserQuestionPopover';

const mockCollapse = jest.fn();
const mockHandlePopoverKeyDown = jest.fn();
/** The popover is memoized, so visibility changes reach it the way the real
 *  hook's state does: through a store it subscribes to. */
const mockVisibility = {
  visible: true,
  listeners: new Set<() => void>(),
  set(visible: boolean) {
    this.visible = visible;
    this.listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void) {
    mockVisibility.listeners.add(listener);
    return () => mockVisibility.listeners.delete(listener);
  },
};
let mockQuestions: Agents.AskUserQuestionBatchItem[] | undefined;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Chat/Messages/Content/ApprovalContext', () => ({
  useAskSubmitStatus: () => ({ getAskStatus: () => 'idle' }),
  useResumeSubmit: () => ({ submitAskAnswer: jest.fn() }),
}));

jest.mock('../overlay', () => ({
  useComposerOverlay: jest.fn(),
}));

jest.mock('~/Providers', () => ({
  useChatFormContext: () => jest.requireActual('react-hook-form').useFormContext(),
}));

jest.mock('~/hooks/Input/useAskAnswerMode', () => ({
  __esModule: true,
  default: () => ({
    popoverVisible: jest
      .requireActual('react')
      .useSyncExternalStore(mockVisibility.subscribe, () => mockVisibility.visible),
    liveAsk: {
      actionId: 'ask-1',
      question: { question: 'Which environment?', options: [{ label: 'Staging', value: 's' }] },
      questions: mockQuestions,
    },
    options: [{ label: 'Staging', value: 's' }],
    selected: null,
    checked: [],
    multiSelect: false,
    locked: false,
    errored: false,
    toggleChecked: jest.fn(),
    canSubmit: false,
    submit: jest.fn(),
    submitOption: jest.fn(),
    skip: jest.fn(),
    collapse: mockCollapse,
    handlePopoverKeyDown: mockHandlePopoverKeyDown,
  }),
}));

function Host({ textAreaRef }: { textAreaRef: React.RefObject<HTMLTextAreaElement> }) {
  const methods = useForm({ defaultValues: { text: '' } });
  return (
    <RecoilRoot>
      <FormProvider {...methods}>
        <textarea ref={textAreaRef} aria-label="Composer" />
        <AskUserQuestionPopover conversationId="conversation-1" textAreaRef={textAreaRef} />
      </FormProvider>
    </RecoilRoot>
  );
}

describe('AskUserQuestionPopover Escape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVisibility.visible = true;
    mockQuestions = undefined;
  });

  /** Escape on `target`, then the popover closes; returns the composer. */
  const escapeThenClose = (target: () => HTMLElement) => {
    const textAreaRef = createRef<HTMLTextAreaElement>();
    render(<Host textAreaRef={textAreaRef} />);
    fireEvent.keyDown(target(), { key: 'Escape' });
    act(() => mockVisibility.set(false));
    return textAreaRef.current;
  };

  test('moves a single question to the chat and returns focus to the composer', () => {
    const composer = escapeThenClose(() => screen.getByRole('button', { name: /Staging/ }));
    expect(mockCollapse).toHaveBeenCalledTimes(1);
    expect(mockHandlePopoverKeyDown).not.toHaveBeenCalled();
    expect(composer).toHaveFocus();
  });

  test('moves a batch to the chat and returns focus to the composer', () => {
    mockQuestions = [
      { id: 'window', question: 'Which time window?' },
      { id: 'region', question: 'Which region?' },
    ];
    const composer = escapeThenClose(() =>
      screen.getByRole('textbox', { name: /Which time window/ }),
    );
    expect(mockCollapse).toHaveBeenCalledTimes(1);
    expect(composer).toHaveFocus();
  });

  test('leaves an Escape that cancels an IME composition alone', () => {
    render(<Host textAreaRef={createRef<HTMLTextAreaElement>()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /Staging/ }), {
      key: 'Escape',
      isComposing: true,
    });
    expect(mockCollapse).not.toHaveBeenCalled();
  });

  test('passes other keys through to the popover shortcuts', () => {
    render(<Host textAreaRef={createRef<HTMLTextAreaElement>()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /Staging/ }), { key: '1' });
    expect(mockHandlePopoverKeyDown).toHaveBeenCalledTimes(1);
    expect(mockCollapse).not.toHaveBeenCalled();
  });
});
