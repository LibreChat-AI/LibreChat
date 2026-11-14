import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  Providers,
  GEMINI_PARTS,
  captureGeminiReplayParts,
  restoreGeminiReplayParts,
  formatAgentMessages,
} from '@librechat/agents';
import type { TMessage } from 'librechat-data-provider';
import type { GoogleThoughtSignatures } from './signatures';
import { collectGoogleThoughtSignatures, restoreGoogleThoughtSignatures } from './signatures';

const sourceMessageId = 'assistant-row';
function row(
  signatures: GoogleThoughtSignatures,
): Pick<TMessage, 'messageId' | 'isCreatedByUser' | 'metadata'> {
  return {
    messageId: sourceMessageId,
    isCreatedByUser: false,
    metadata: { thoughtSignatures: signatures },
  };
}
function signedText(text: string, signature: string): AIMessage {
  const message = new AIMessage(text);
  captureGeminiReplayParts(message, [{ text, thoughtSignature: signature }]);
  return message;
}

describe.each([Providers.GOOGLE, Providers.VERTEXAI])('persisted %s signatures', (provider) => {
  it('restores separate model invocations from the same persisted assistant row without usage metadata', () => {
    const collected: GoogleThoughtSignatures = {};
    collectGoogleThoughtSignatures(collected, signedText('First answer', 'first-signature'));
    collectGoogleThoughtSignatures(collected, signedText('Final answer', 'final-signature'));
    const messages = ['First answer', 'Final answer'].map(
      (content) => new AIMessage({ content, additional_kwargs: { sourceMessageId } }),
    );
    restoreGoogleThoughtSignatures(messages, [row(collected)], [{ provider }]);
    expect(messages.map((message) => restoreGeminiReplayParts(message))).toEqual([
      [{ text: 'First answer', thoughtSignature: 'first-signature' }],
      [{ text: 'Final answer', thoughtSignature: 'final-signature' }],
    ]);
  });

  it('replays signed text after the actual stored-history formatter', () => {
    const collected: GoogleThoughtSignatures = {};
    collectGoogleThoughtSignatures(collected, signedText('Stored answer', 'stored-signature'));
    const history = {
      ...row(collected),
      role: 'assistant' as const,
      text: 'Stored answer',
      content: [{ type: 'text' as const, text: 'Stored answer' }],
    };
    const { messages } = formatAgentMessages([history]);
    restoreGoogleThoughtSignatures(messages, [history], [{ provider }]);
    expect(restoreGeminiReplayParts(messages[0])).toEqual([
      { text: 'Stored answer', thoughtSignature: 'stored-signature' },
    ]);
  });

  it('replays signed thinking through the persisted-history formatter', () => {
    const native = [
      { text: 'Thinking', thought: true, thoughtSignature: 'thought-signature' },
      { text: 'Stored answer', thoughtSignature: 'text-signature' },
    ];
    const output = new AIMessage('Stored answer');
    captureGeminiReplayParts(output, native);
    const collected: GoogleThoughtSignatures = {};
    collectGoogleThoughtSignatures(collected, output);
    const history = {
      ...row(collected),
      role: 'assistant' as const,
      text: 'Stored answer',
      content: [
        { type: 'think' as const, think: 'Thinking' },
        { type: 'text' as const, text: 'Stored answer' },
      ],
    };
    const { messages } = formatAgentMessages([history], undefined, undefined, undefined, {
      preserveReasoningContent: true,
      preserveTextContent: true,
    });
    restoreGoogleThoughtSignatures(messages, [history], [{ provider }]);
    expect(restoreGeminiReplayParts(messages[0])).toEqual(native);
  });

  it('keeps text, thinking, and parallel tool signatures in their native positions', () => {
    const tool_calls = [
      { id: 'a', name: 'lookup', args: { query: 'one' } },
      { id: 'b', name: 'lookup', args: { query: 'two' } },
    ];
    const native = [
      { text: 'Thinking', thought: true, thoughtSignature: 'thinking-signature' },
      { text: 'Checking' },
      { functionCall: tool_calls[0], thoughtSignature: 'call-signature' },
      { functionCall: tool_calls[1] },
    ];
    const output = new AIMessage({ content: 'Checking', tool_calls });
    captureGeminiReplayParts(output, native);
    const collected: GoogleThoughtSignatures = {};
    collectGoogleThoughtSignatures(collected, output);
    const restored = new AIMessage({
      content: [
        { type: 'thinking', thinking: 'Thinking' },
        { type: 'text', text: 'Checking' },
      ],
      tool_calls,
      additional_kwargs: { sourceMessageId },
    });
    restoreGoogleThoughtSignatures([restored], [row(collected)], [{ provider }]);
    expect(restoreGeminiReplayParts(restored)).toEqual(native);
  });

  it.each(['edited', 'pruned', 'wrong-row', 'user-row', 'ambiguous'])(
    'never attaches stale signatures for %s history',
    (variant) => {
      const collected: GoogleThoughtSignatures = {};
      collectGoogleThoughtSignatures(collected, signedText('Original answer', 'signature'));
      if (variant === 'ambiguous')
        collectGoogleThoughtSignatures(collected, signedText('Original answer', 'other-signature'));
      const contentByVariant: Record<string, string> = {
        edited: 'Edited answer',
        pruned: 'Original',
      };
      const message = new AIMessage({
        content: contentByVariant[variant] ?? 'Original answer',
        additional_kwargs: {
          sourceMessageId: variant === 'wrong-row' ? 'other-row' : sourceMessageId,
        },
      });
      const history = row(collected);
      if (variant === 'user-row') history.isCreatedByUser = true;
      restoreGoogleThoughtSignatures([message], [history], [{ provider }]);
      expect(message.additional_kwargs).not.toHaveProperty(GEMINI_PARTS);
    },
  );

  it('restores a call-only invocation beside native turns without falling back for edited native calls', () => {
    const collected: GoogleThoughtSignatures = {};
    const nativeCall = { id: 'native', name: 'lookup', args: {} };
    const native = new AIMessage({ content: 'Original', tool_calls: [nativeCall] });
    captureGeminiReplayParts(native, [
      { text: 'Original' },
      { functionCall: nativeCall, thoughtSignature: 'native-signature' },
    ]);
    collectGoogleThoughtSignatures(collected, native);
    const legacyCall = { id: 'legacy', name: 'lookup', args: {} };
    collectGoogleThoughtSignatures(collected, {
      tool_calls: [legacyCall],
      additional_kwargs: {
        __gemini_function_call_thought_signatures__: { legacy: 'legacy-signature' },
      },
    });
    const edited = new AIMessage({
      content: 'Edited',
      tool_calls: [nativeCall],
      additional_kwargs: { sourceMessageId },
    });
    const legacy = new AIMessage({
      content: '',
      tool_calls: [legacyCall],
      additional_kwargs: { sourceMessageId },
    });
    restoreGoogleThoughtSignatures([edited, legacy], [row(collected)], [{ provider }]);
    expect(edited.additional_kwargs).not.toHaveProperty(GEMINI_PARTS);
    expect(edited.additional_kwargs).not.toHaveProperty(
      '__gemini_function_call_thought_signatures__',
    );
    expect(legacy.additional_kwargs.__gemini_function_call_thought_signatures__).toEqual({
      legacy: 'legacy-signature',
    });
  });

  it('restores legacy maps by call id and preserves unsigned parallel slots', () => {
    const message = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'a', name: 'lookup', args: {} },
        { id: 'b', name: 'lookup', args: {} },
      ],
      additional_kwargs: { sourceMessageId },
    });
    const history = { ...row({}), metadata: { thoughtSignatures: { b: 'signed-b' } } };
    restoreGoogleThoughtSignatures([message], [history], [{ provider }]);
    expect(message.additional_kwargs.__gemini_function_call_thought_signatures__).toEqual({
      b: 'signed-b',
    });
    if (provider === Providers.VERTEXAI)
      expect(message.additional_kwargs.signatures).toEqual(['', 'signed-b']);
  });
});

it('does not expose Google metadata to another provider or a user message', () => {
  const collected: GoogleThoughtSignatures = {};
  collectGoogleThoughtSignatures(collected, signedText('Answer', 'signature'));
  const message = new AIMessage({ content: 'Answer', additional_kwargs: { sourceMessageId } });
  const user = new HumanMessage({ content: 'Answer', additional_kwargs: { sourceMessageId } });
  restoreGoogleThoughtSignatures(
    [message, user],
    [row(collected)],
    [{ provider: Providers.OPENAI }],
  );
  expect(message.additional_kwargs).not.toHaveProperty(GEMINI_PARTS);
  restoreGoogleThoughtSignatures([user], [row(collected)], [{ provider: Providers.GOOGLE }]);
  expect(user.additional_kwargs).not.toHaveProperty(GEMINI_PARTS);
});

it('restores signed history for a reachable Google agent under a different primary provider', () => {
  const collected: GoogleThoughtSignatures = {};
  collectGoogleThoughtSignatures(collected, signedText('Answer', 'signature'));
  const message = new AIMessage({ content: 'Answer', additional_kwargs: { sourceMessageId } });
  restoreGoogleThoughtSignatures(
    [message],
    [row(collected)],
    [{ provider: Providers.OPENAI }, { provider: Providers.GOOGLE }],
  );
  expect(restoreGeminiReplayParts(message)).toEqual([
    { text: 'Answer', thoughtSignature: 'signature' },
  ]);
});
