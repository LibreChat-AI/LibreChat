const mockSetShowMentionPopover = jest.fn();
const mockSetShowPlusPopover = jest.fn();
const mockSetShowPromptsPopover = jest.fn();
const mockSetShowSkillsPopover = jest.fn();
const mockHasPromptsAccess = { current: true };
const mockHasMultiConvoAccess = { current: true };
const mockHasSkillsAccess = { current: true };
const mockSkillsEnabled = { current: true };
const mockEndpoint = { current: 'openAI' as string | null };
const mockCommandToggles = { at: true, plus: true, slash: true, dollar: true };

jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useSetAtom: jest.fn((atom: string) =>
    atom === 'showSkillsPopoverFamily-0' ? mockSetShowSkillsPopover : jest.fn(),
  ),
}));

jest.mock('~/components/Chat/Input/skillsState', () => ({
  showSkillsPopoverFamily: (idx: number) => `showSkillsPopoverFamily-${idx}`,
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: jest.fn((atom) => {
    if (atom === 'effectiveEndpointByIndex-0') {
      return mockEndpoint.current;
    }
    if (atom === 'atCommand') {
      return mockCommandToggles.at;
    }
    if (atom === 'plusCommand') {
      return mockCommandToggles.plus;
    }
    if (atom === 'slashCommand') {
      return mockCommandToggles.slash;
    }
    if (atom === 'dollarCommand') {
      return mockCommandToggles.dollar;
    }
    return undefined;
  }),
  useSetRecoilState: jest.fn((atom: string) => {
    if (atom === 'showMentionPopoverFamily-0') {
      return mockSetShowMentionPopover;
    }
    if (atom === 'showPlusPopoverFamily-0') {
      return mockSetShowPlusPopover;
    }
    if (atom === 'showPromptsPopoverFamily-0') {
      return mockSetShowPromptsPopover;
    }
    return jest.fn();
  }),
}));

jest.mock('~/store', () => ({
  showPromptsPopoverFamily: (idx: number) => `showPromptsPopoverFamily-${idx}`,
  showMentionPopoverFamily: (idx: number) => `showMentionPopoverFamily-${idx}`,
  showPlusPopoverFamily: (idx: number) => `showPlusPopoverFamily-${idx}`,
  effectiveEndpointByIndex: (idx: number) => `effectiveEndpointByIndex-${idx}`,
  atCommand: 'atCommand',
  plusCommand: 'plusCommand',
  slashCommand: 'slashCommand',
  dollarCommand: 'dollarCommand',
}));

jest.mock('~/hooks/Roles/useHasAccess', () =>
  jest.fn(({ permissionType }: { permissionType: string }) => {
    if (permissionType === 'PROMPTS') {
      return mockHasPromptsAccess.current;
    }
    if (permissionType === 'MULTI_CONVO') {
      return mockHasMultiConvoAccess.current;
    }
    if (permissionType === 'SKILLS') {
      return mockHasSkillsAccess.current;
    }
    return false;
  }),
);

jest.mock('~/hooks/Agents/useGetAgentsConfig', () =>
  jest.fn(() => ({ agentsConfig: { capabilities: [] } })),
);

jest.mock('~/hooks/Agents/useAgentCapabilities', () =>
  jest.fn(() => ({
    skillsEnabled: mockSkillsEnabled.current,
  })),
);

jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useGetLatestMessage: jest.fn(() => () => null),
}));

import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useGetLatestMessage } from '~/hooks/Messages/useLatestMessage';
import useHandleKeyUp from './useHandleKeyUp';

const mockUseGetLatestMessage = useGetLatestMessage as jest.Mock;

const makeTextAreaRef = (value = '', selectionStart?: number) => {
  const ref = {
    current: {
      value,
      selectionStart: selectionStart ?? value.length,
    },
  } as unknown as React.RefObject<HTMLTextAreaElement>;
  return ref;
};

const makeKeyEvent = (key: string) =>
  ({ key, preventDefault: jest.fn() }) as unknown as React.KeyboardEvent<HTMLTextAreaElement>;

const renderUseHandleKeyUp = (
  textAreaRef: React.RefObject<HTMLTextAreaElement>,
  overrides?: { index?: number },
) => {
  const { result } = renderHook(() =>
    useHandleKeyUp({
      index: overrides?.index ?? 0,
      textAreaRef,
    }),
  );

  return {
    handleKeyUp: result.current,
    setShowMentionPopover: mockSetShowMentionPopover,
    setShowPlusPopover: mockSetShowPlusPopover,
    setShowPromptsPopover: mockSetShowPromptsPopover,
    setShowSkillsPopover: mockSetShowSkillsPopover,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockHasPromptsAccess.current = true;
  mockHasMultiConvoAccess.current = true;
  mockHasSkillsAccess.current = true;
  mockSkillsEnabled.current = true;
  mockEndpoint.current = 'openAI';
  mockCommandToggles.at = true;
  mockCommandToggles.plus = true;
  mockCommandToggles.slash = true;
  mockCommandToggles.dollar = true;
});

describe('useHandleKeyUp', () => {
  describe('command triggering — normal typing speed (cursor at position 1)', () => {
    it('triggers slash command for "/" at position 1', () => {
      const ref = makeTextAreaRef('/', 1);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('/')));

      expect(setShowPromptsPopover).toHaveBeenCalledWith(true);
    });

    it('triggers @ mention for "@" at position 1', () => {
      const ref = makeTextAreaRef('@', 1);
      const { handleKeyUp, setShowMentionPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('@')));

      expect(setShowMentionPopover).toHaveBeenCalledWith(true);
    });

    it('triggers + command for "+" at position 1', () => {
      const ref = makeTextAreaRef('+', 1);
      const { handleKeyUp, setShowPlusPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('+')));

      expect(setShowPlusPopover).toHaveBeenCalledWith(true);
    });

    it('triggers $ skill command for "$" at position 1', () => {
      const ref = makeTextAreaRef('$', 1);
      const { handleKeyUp, setShowSkillsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('$')));

      expect(setShowSkillsPopover).toHaveBeenCalledWith(true);
    });

    it('triggers $ skill command when $ is inserted before an existing draft', () => {
      const ref = makeTextAreaRef('$Keep this draft', 1);
      const { handleKeyUp, setShowSkillsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('$')));

      expect(setShowSkillsPopover).toHaveBeenCalledWith(true);
    });
  });

  describe('fast typing — cursor past position 1 but text is short', () => {
    it('triggers slash command for "/sc" (fast typed)', () => {
      const ref = makeTextAreaRef('/sc', 3);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('c')));

      expect(setShowPromptsPopover).toHaveBeenCalledWith(true);
    });

    it('triggers @ mention for "@bo" (fast typed)', () => {
      const ref = makeTextAreaRef('@bo', 3);
      const { handleKeyUp, setShowMentionPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('o')));

      expect(setShowMentionPopover).toHaveBeenCalledWith(true);
    });

    it('triggers for text up to MAX_COMMAND_TRIGGER_LENGTH (5 chars)', () => {
      const ref = makeTextAreaRef('/abcd', 5);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('d')));

      expect(setShowPromptsPopover).toHaveBeenCalledWith(true);
    });

    it('triggers $ skill command for "$sk" (fast typed)', () => {
      const ref = makeTextAreaRef('$sk', 3);
      const { handleKeyUp, setShowSkillsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('k')));

      expect(setShowSkillsPopover).toHaveBeenCalledWith(true);
    });

    it('does NOT trigger for text exceeding MAX_COMMAND_TRIGGER_LENGTH', () => {
      const ref = makeTextAreaRef('/abcde', 6);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('e')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });
  });

  describe('navigation keys — should never trigger', () => {
    it('does NOT trigger when cursor is mid-text after ArrowLeft', () => {
      const ref = makeTextAreaRef('/abc', 2);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('ArrowLeft')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger when cursor is mid-text after Delete', () => {
      const ref = makeTextAreaRef('@bo', 2);
      const { handleKeyUp, setShowMentionPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('Delete')));

      expect(setShowMentionPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger when ArrowRight lands at end of short command text', () => {
      const ref = makeTextAreaRef('/ab', 3);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('ArrowRight')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger when Home key is pressed on command text', () => {
      const ref = makeTextAreaRef('/abc', 0);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('Home')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger when End key lands at end of short command text', () => {
      const ref = makeTextAreaRef('+ab', 3);
      const { handleKeyUp, setShowPlusPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('End')));

      expect(setShowPlusPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger when ArrowUp is pressed on non-empty command text', () => {
      const ref = makeTextAreaRef('/ab', 3);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('ArrowUp')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });
  });

  describe('paste protection — long text starting with command char', () => {
    it('does NOT trigger for pasted "/api/v1/users"', () => {
      const ref = makeTextAreaRef('/api/v1/users', 13);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('v')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger for pasted "@username mentioned in a long message"', () => {
      const ref = makeTextAreaRef('@username mentioned in a long message', 37);
      const { handleKeyUp, setShowMentionPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('v')));

      expect(setShowMentionPopover).not.toHaveBeenCalled();
    });
  });

  describe('non-command text', () => {
    it('does NOT trigger when text does not start with a command char', () => {
      const ref = makeTextAreaRef('hello', 5);
      const { handleKeyUp, setShowPromptsPopover, setShowMentionPopover, setShowPlusPopover } =
        renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('o')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
      expect(setShowMentionPopover).not.toHaveBeenCalled();
      expect(setShowPlusPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger when text is empty', () => {
      const ref = makeTextAreaRef('', 0);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('a')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger for command char in the middle of text', () => {
      const ref = makeTextAreaRef('hello /world', 12);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('d')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });
  });

  describe('invalid keys', () => {
    it.each([
      'Escape',
      'Backspace',
      'Enter',
      'ArrowUp',
      'ArrowLeft',
      'ArrowRight',
      'ArrowDown',
      'Home',
      'End',
      'Delete',
    ])('does NOT trigger on %s key', (key) => {
      const ref = makeTextAreaRef('/', 1);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent(key)));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });
  });

  describe('command toggles', () => {
    it('does NOT trigger slash command when slashCommand toggle is disabled', () => {
      mockCommandToggles.slash = false;
      const ref = makeTextAreaRef('/', 1);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('/')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger @ mention when atCommand toggle is disabled', () => {
      mockCommandToggles.at = false;
      const ref = makeTextAreaRef('@', 1);
      const { handleKeyUp, setShowMentionPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('@')));

      expect(setShowMentionPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger + command when plusCommand toggle is disabled', () => {
      mockCommandToggles.plus = false;
      const ref = makeTextAreaRef('+', 1);
      const { handleKeyUp, setShowPlusPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('+')));

      expect(setShowPlusPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger $ skill command when dollarCommand toggle is disabled', () => {
      mockCommandToggles.dollar = false;
      const ref = makeTextAreaRef('$', 1);
      const { handleKeyUp, setShowSkillsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('$')));

      expect(setShowSkillsPopover).not.toHaveBeenCalled();
    });
  });

  describe('permission gating', () => {
    it('does NOT trigger slash command without PROMPTS access', () => {
      mockHasPromptsAccess.current = false;
      const ref = makeTextAreaRef('/', 1);
      const { handleKeyUp, setShowPromptsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('/')));

      expect(setShowPromptsPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger + command without MULTI_CONVO access', () => {
      mockHasMultiConvoAccess.current = false;
      const ref = makeTextAreaRef('+', 1);
      const { handleKeyUp, setShowPlusPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('+')));

      expect(setShowPlusPopover).not.toHaveBeenCalled();
    });

    it('triggers @ mention regardless of other permissions', () => {
      mockHasPromptsAccess.current = false;
      mockHasMultiConvoAccess.current = false;
      const ref = makeTextAreaRef('@', 1);
      const { handleKeyUp, setShowMentionPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('@')));

      expect(setShowMentionPopover).toHaveBeenCalledWith(true);
    });

    it('does NOT trigger $ skill command without SKILLS access', () => {
      mockHasSkillsAccess.current = false;
      const ref = makeTextAreaRef('$', 1);
      const { handleKeyUp, setShowSkillsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('$')));

      expect(setShowSkillsPopover).not.toHaveBeenCalled();
    });

    it('does NOT trigger $ skill command when skills capability is disabled on agents endpoint', () => {
      mockSkillsEnabled.current = false;
      const ref = makeTextAreaRef('$', 1);
      const { handleKeyUp, setShowSkillsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('$')));

      expect(setShowSkillsPopover).not.toHaveBeenCalled();
    });
  });

  describe('endpoint gating', () => {
    it('does NOT trigger + command on assistants endpoint', () => {
      mockEndpoint.current = 'assistants';
      const ref = makeTextAreaRef('+', 1);
      const { handleKeyUp, setShowPlusPopover } = renderUseHandleKeyUp(ref);
      setShowPlusPopover.mockClear();

      act(() => handleKeyUp(makeKeyEvent('+')));

      expect(setShowPlusPopover).not.toHaveBeenCalledWith(true);
    });

    it('does NOT trigger + command on azureAssistants endpoint', () => {
      mockEndpoint.current = 'azureAssistants';
      const ref = makeTextAreaRef('+', 1);
      const { handleKeyUp, setShowPlusPopover } = renderUseHandleKeyUp(ref);
      setShowPlusPopover.mockClear();

      act(() => handleKeyUp(makeKeyEvent('+')));

      expect(setShowPlusPopover).not.toHaveBeenCalledWith(true);
    });

    it('resets + popover when endpoint switches to assistants', () => {
      mockEndpoint.current = 'assistants';
      const ref = makeTextAreaRef('', 0);
      const { setShowPlusPopover } = renderUseHandleKeyUp(ref);

      expect(setShowPlusPopover).toHaveBeenCalledWith(false);
    });

    it('triggers + command on non-assistants endpoint', () => {
      mockEndpoint.current = 'openAI';
      const ref = makeTextAreaRef('+', 1);
      const { handleKeyUp, setShowPlusPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('+')));

      expect(setShowPlusPopover).toHaveBeenCalledWith(true);
    });

    it('does NOT trigger $ skill command on assistants endpoint', () => {
      mockEndpoint.current = 'assistants';
      const ref = makeTextAreaRef('$', 1);
      const { handleKeyUp, setShowSkillsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('$')));

      expect(setShowSkillsPopover).not.toHaveBeenCalledWith(true);
    });

    it('does NOT trigger $ skill command on azureAssistants endpoint', () => {
      mockEndpoint.current = 'azureAssistants';
      const ref = makeTextAreaRef('$', 1);
      const { handleKeyUp, setShowSkillsPopover } = renderUseHandleKeyUp(ref);

      act(() => handleKeyUp(makeKeyEvent('$')));

      expect(setShowSkillsPopover).not.toHaveBeenCalledWith(true);
    });

    it('resets $ skills popover when endpoint switches to assistants', () => {
      mockEndpoint.current = 'assistants';
      const ref = makeTextAreaRef('', 0);
      const { setShowSkillsPopover } = renderUseHandleKeyUp(ref);

      expect(setShowSkillsPopover).toHaveBeenCalledWith(false);
    });
  });

  describe('ArrowUp edits the latest message (call-time tail read)', () => {
    const parentMessageId = 'user-msg-1';
    let editButton: HTMLButtonElement | null = null;

    const mountEditButton = (id = `edit-${parentMessageId}`) => {
      editButton = document.createElement('button');
      editButton.id = id;
      document.body.appendChild(editButton);
      return jest.spyOn(editButton, 'click');
    };

    afterEach(() => {
      editButton?.remove();
      editButton = null;
      mockUseGetLatestMessage.mockReturnValue(() => null);
    });

    it('clicks the edit control for the latest message parent on ArrowUp in an empty composer', () => {
      mockUseGetLatestMessage.mockReturnValue(() => ({
        messageId: 'assistant-1',
        parentMessageId,
      }));
      const click = mountEditButton();
      const { handleKeyUp } = renderUseHandleKeyUp(makeTextAreaRef('', 0));
      const event = makeKeyEvent('ArrowUp');

      act(() => handleKeyUp(event));

      expect(event.preventDefault).toHaveBeenCalled();
      expect(click).toHaveBeenCalled();
    });

    it('does nothing when there is no latest message', () => {
      mockUseGetLatestMessage.mockReturnValue(() => null);
      const click = mountEditButton();
      const { handleKeyUp } = renderUseHandleKeyUp(makeTextAreaRef('', 0));
      const event = makeKeyEvent('ArrowUp');

      act(() => handleKeyUp(event));

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
    });

    it('does not preventDefault when the edit control is absent', () => {
      mockUseGetLatestMessage.mockReturnValue(() => ({
        messageId: 'assistant-1',
        parentMessageId: 'missing',
      }));
      const { handleKeyUp } = renderUseHandleKeyUp(makeTextAreaRef('', 0));
      const event = makeKeyEvent('ArrowUp');

      act(() => handleKeyUp(event));

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('ignores ArrowUp when the composer has text', () => {
      const reader = jest.fn(() => ({ messageId: 'assistant-1', parentMessageId }));
      mockUseGetLatestMessage.mockReturnValue(reader);
      mountEditButton();
      const { handleKeyUp } = renderUseHandleKeyUp(makeTextAreaRef('draft', 5));
      const event = makeKeyEvent('ArrowUp');

      act(() => handleKeyUp(event));

      expect(reader).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });
});
