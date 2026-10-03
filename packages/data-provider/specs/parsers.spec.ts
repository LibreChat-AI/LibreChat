import {
  parseConvo,
  parseTextParts,
  parseCompactConvo,
  replaceSpecialVars,
  getEphemeralSender,
  getResponseSender,
  isConfiguredSender,
  encodeEphemeralAgentId,
  parseEphemeralAgentId,
} from '../src/parsers';
import { specialVariables } from '../src/config';
import { EModelEndpoint, Providers, ThinkingDisplay, AnthropicEffort } from '../src/schemas';
import { ContentTypes } from '../src/types/runs';
import type { TMessageContentParts } from '../src/types/content';
import type { TUser, TConversation } from '../src/types';

// Mock dayjs module with consistent date/time values regardless of environment
jest.mock('dayjs', () => {
  const mockDayjs = (input?: unknown) => ({
    format: (format: string) => {
      if (input === '2023-12-31T23:59:58.000Z') {
        if (format === 'YYYY-MM-DD') {
          return '2023-12-31';
        }
        if (format === 'YYYY-MM-DD HH:mm:ss Z') {
          return '2023-12-31 23:59:58 +00:00';
        }
        if (format === 'dddd') {
          return 'Sunday';
        }
      }
      if (format === 'YYYY-MM-DD') {
        return '2024-04-29';
      }
      if (format === 'YYYY-MM-DD HH:mm:ss Z') {
        return '2024-04-29 12:34:56 -04:00';
      }
      if (format === 'dddd') {
        return 'Monday';
      }
      throw new Error(
        `Unhandled dayjs().format() call in mock: "${format}". Update the mock in parsers.spec.ts`,
      );
    },
    toISOString: () =>
      input === '2023-12-31T23:59:58.000Z'
        ? '2023-12-31T23:59:58.000Z'
        : '2024-04-29T16:34:56.000Z',
  });

  mockDayjs.extend = jest.fn();

  return mockDayjs;
});

describe('replaceSpecialVars', () => {
  // Create a partial user object for testing
  const mockUser = {
    name: 'Test User',
    id: 'user123',
  } as TUser;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should return the original text if text is empty', () => {
    expect(replaceSpecialVars({ text: '' })).toBe('');
    expect(replaceSpecialVars({ text: null as unknown as string })).toBe(null);
    expect(replaceSpecialVars({ text: undefined as unknown as string })).toBe(undefined);
  });

  test('should replace {{current_date}} with the current date', () => {
    const result = replaceSpecialVars({ text: 'Today is {{current_date}}' });
    expect(result).toBe('Today is 2024-04-29 (Monday)');
  });

  test('should replace {{current_datetime}} with the current datetime', () => {
    const result = replaceSpecialVars({ text: 'Now is {{current_datetime}}' });
    expect(result).toBe('Now is 2024-04-29 12:34:56 -04:00 (Monday)');
  });

  test('should replace {{iso_datetime}} with the ISO datetime', () => {
    const result = replaceSpecialVars({ text: 'ISO time: {{iso_datetime}}' });
    expect(result).toBe('ISO time: 2024-04-29T16:34:56.000Z');
  });

  test('should use supplied anchor time for date variables', () => {
    const result = replaceSpecialVars({
      text: '{{current_date}} | {{current_datetime}} | {{iso_datetime}}',
      now: '2023-12-31T23:59:58.000Z',
    });
    expect(result).toBe(
      '2023-12-31 (Sunday) | 2023-12-31 23:59:58 +00:00 (Sunday) | 2023-12-31T23:59:58.000Z',
    );
  });

  test('should replace special variables with surrounding whitespace', () => {
    const result = replaceSpecialVars({
      text: '{{ current_date }} | {{ current_user }}',
      user: mockUser,
    });

    expect(result).toBe('2024-04-29 (Monday) | Test User');
  });

  test('should replace {{current_user}} with the user name if provided', () => {
    const result = replaceSpecialVars({
      text: 'Hello {{current_user}}!',
      user: mockUser,
    });
    expect(result).toBe('Hello Test User!');
  });

  test('should not replace {{current_user}} if user is not provided', () => {
    const result = replaceSpecialVars({
      text: 'Hello {{current_user}}!',
    });
    expect(result).toBe('Hello {{current_user}}!');
  });

  test('should not replace {{current_user}} if user has no name', () => {
    const result = replaceSpecialVars({
      text: 'Hello {{current_user}}!',
      user: { id: 'user123' } as TUser,
    });
    expect(result).toBe('Hello {{current_user}}!');
  });

  test('should handle multiple replacements in the same text', () => {
    const result = replaceSpecialVars({
      text: 'Hello {{current_user}}! Today is {{current_date}} and the time is {{current_datetime}}. ISO: {{iso_datetime}}',
      user: mockUser,
    });
    expect(result).toBe(
      'Hello Test User! Today is 2024-04-29 (Monday) and the time is 2024-04-29 12:34:56 -04:00 (Monday). ISO: 2024-04-29T16:34:56.000Z',
    );
  });

  test('should be case-insensitive when replacing variables', () => {
    const result = replaceSpecialVars({
      text: 'Date: {{CURRENT_DATE}}, User: {{Current_User}}',
      user: mockUser,
    });
    expect(result).toBe('Date: 2024-04-29 (Monday), User: Test User');
  });

  test('should confirm all specialVariables from config.ts get parsed', () => {
    // Create a text that includes all special variables
    const specialVarsText = Object.keys(specialVariables)
      .map((key) => `{{${key}}}`)
      .join(' ');

    const result = replaceSpecialVars({
      text: specialVarsText,
      user: mockUser,
    });

    // Verify none of the original variable placeholders remain in the result
    Object.keys(specialVariables).forEach((key) => {
      const placeholder = `{{${key}}}`;
      expect(result).not.toContain(placeholder);
    });

    // Verify the expected replacements
    expect(result).toContain('2024-04-29 (Monday)'); // current_date
    expect(result).toContain('2024-04-29 12:34:56 -04:00 (Monday)'); // current_datetime
    expect(result).toContain('2024-04-29T16:34:56.000Z'); // iso_datetime
    expect(result).toContain('Test User'); // current_user
  });
});

describe('parseCompactConvo', () => {
  describe('iconURL security sanitization', () => {
    test('should strip iconURL from OpenAI endpoint conversation input', () => {
      const maliciousIconURL = 'https://evil-tracker.example.com/pixel.png?user=victim';
      const conversation: Partial<TConversation> = {
        model: 'gpt-4',
        iconURL: maliciousIconURL,
        endpoint: EModelEndpoint.openAI,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.openAI,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('gpt-4');
    });

    test('should strip iconURL from agents endpoint conversation input', () => {
      const maliciousIconURL = 'https://evil-tracker.example.com/pixel.png';
      const conversation: Partial<TConversation> = {
        agent_id: 'agent_123',
        iconURL: maliciousIconURL,
        endpoint: EModelEndpoint.agents,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.agents,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.agent_id).toBe('agent_123');
    });

    test('should strip iconURL from anthropic endpoint conversation input', () => {
      const maliciousIconURL = 'https://tracker.malicious.com/beacon.gif';
      const conversation: Partial<TConversation> = {
        model: 'claude-3-opus',
        iconURL: maliciousIconURL,
        endpoint: EModelEndpoint.anthropic,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.anthropic,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('claude-3-opus');
    });

    test('should strip iconURL from google endpoint conversation input', () => {
      const maliciousIconURL = 'https://tracking.example.com/spy.png';
      const conversation: Partial<TConversation> = {
        model: 'gemini-pro',
        iconURL: maliciousIconURL,
        endpoint: EModelEndpoint.google,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.google,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('gemini-pro');
    });

    test('should strip iconURL from assistants endpoint conversation input', () => {
      const maliciousIconURL = 'https://evil.com/track.png';
      const conversation: Partial<TConversation> = {
        assistant_id: 'asst_123',
        iconURL: maliciousIconURL,
        endpoint: EModelEndpoint.assistants,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.assistants,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.assistant_id).toBe('asst_123');
    });

    test('should preserve other conversation properties while stripping iconURL', () => {
      const conversation: Partial<TConversation> = {
        model: 'gpt-4',
        iconURL: 'https://malicious.com/track.png',
        endpoint: EModelEndpoint.openAI,
        temperature: 0.7,
        top_p: 0.9,
        promptPrefix: 'You are a helpful assistant.',
        maxContextTokens: 4000,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.openAI,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('gpt-4');
      expect(result?.temperature).toBe(0.7);
      expect(result?.top_p).toBe(0.9);
      expect(result?.promptPrefix).toBe('You are a helpful assistant.');
      expect(result?.maxContextTokens).toBe(4000);
    });

    test('should handle conversation without iconURL (no error)', () => {
      const conversation: Partial<TConversation> = {
        model: 'gpt-4',
        endpoint: EModelEndpoint.openAI,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.openAI,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('gpt-4');
    });
  });

  describe('agents generation params', () => {
    const generationParams = {
      agent_id: 'agent_123',
      spec: 'claude-sonnet-5',
      model: 'claude-sonnet-5',
      maxContextTokens: 1000000,
      temperature: 0.3,
      topP: 0.9,
      top_p: 0.85,
      thinking: true,
      thinkingDisplay: ThinkingDisplay.summarized,
      effort: AnthropicEffort.high,
      maxOutputTokens: 8192,
      max_tokens: 4096,
    } satisfies Partial<TConversation>;

    test('preserves UI generation params and omits model', () => {
      const result = parseCompactConvo({
        endpoint: EModelEndpoint.agents,
        conversation: generationParams,
      });

      expect(result).not.toBeNull();
      expect(result?.agent_id).toBe('agent_123');
      expect(result?.spec).toBe('claude-sonnet-5');
      expect(result?.maxContextTokens).toBe(1000000);
      expect(result?.temperature).toBe(0.3);
      expect(result?.topP).toBe(0.9);
      expect(result?.top_p).toBe(0.85);
      expect(result?.thinking).toBe(true);
      expect(result?.thinkingDisplay).toBe(ThinkingDisplay.summarized);
      expect(result?.effort).toBe(AnthropicEffort.high);
      expect(result?.maxOutputTokens).toBe(8192);
      expect(result?.max_tokens).toBe(4096);
      expect(result?.model).toBeUndefined();
    });

    test('drops unknown request fields the way other compact schemas do', () => {
      const result = parseCompactConvo({
        endpoint: EModelEndpoint.agents,
        conversation: {
          ...generationParams,
          conversationId: 'convo-1',
          title: 'New Chat',
        },
      });

      expect(result).not.toBeNull();
      expect(result?.maxContextTokens).toBe(1000000);
      expect(result?.conversationId).toBeUndefined();
      expect(result?.title).toBeUndefined();
    });
  });
});

describe('parseConvo - defaultParamsEndpoint', () => {
  test('should strip maxOutputTokens for custom endpoint without defaultParamsEndpoint', () => {
    const conversation: Partial<TConversation> = {
      model: 'anthropic/claude-opus-4.5',
      temperature: 0.7,
      maxOutputTokens: 8192,
      maxContextTokens: 50000,
    };

    const result = parseConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
    });

    expect(result).not.toBeNull();
    expect(result?.temperature).toBe(0.7);
    expect(result?.maxContextTokens).toBe(50000);
    expect(result?.maxOutputTokens).toBeUndefined();
  });

  test('should preserve maxOutputTokens when defaultParamsEndpoint is anthropic', () => {
    const conversation: Partial<TConversation> = {
      model: 'anthropic/claude-opus-4.5',
      temperature: 0.7,
      maxOutputTokens: 8192,
      topP: 0.9,
      topK: 40,
      maxContextTokens: 50000,
    };

    const result = parseConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
      defaultParamsEndpoint: EModelEndpoint.anthropic,
    });

    expect(result).not.toBeNull();
    expect(result?.model).toBe('anthropic/claude-opus-4.5');
    expect(result?.temperature).toBe(0.7);
    expect(result?.maxOutputTokens).toBe(8192);
    expect(result?.topP).toBe(0.9);
    expect(result?.topK).toBe(40);
    expect(result?.maxContextTokens).toBe(50000);
  });

  test('should strip OpenAI-specific fields when defaultParamsEndpoint is anthropic', () => {
    const conversation: Partial<TConversation> = {
      model: 'anthropic/claude-opus-4.5',
      temperature: 0.7,
      max_tokens: 4096,
      top_p: 0.9,
      presence_penalty: 0.5,
      frequency_penalty: 0.3,
    };

    const result = parseConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
      defaultParamsEndpoint: EModelEndpoint.anthropic,
    });

    expect(result).not.toBeNull();
    expect(result?.temperature).toBe(0.7);
    expect(result?.max_tokens).toBeUndefined();
    expect(result?.top_p).toBeUndefined();
    expect(result?.presence_penalty).toBeUndefined();
    expect(result?.frequency_penalty).toBeUndefined();
  });

  test('should preserve max_tokens when defaultParamsEndpoint is not set (OpenAI default)', () => {
    const conversation: Partial<TConversation> = {
      model: 'gpt-4o',
      temperature: 0.7,
      max_tokens: 4096,
      top_p: 0.9,
    };

    const result = parseConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
    });

    expect(result).not.toBeNull();
    expect(result?.max_tokens).toBe(4096);
    expect(result?.top_p).toBe(0.9);
  });

  test('should preserve Google-specific fields when defaultParamsEndpoint is google', () => {
    const conversation: Partial<TConversation> = {
      model: 'gemini-pro',
      temperature: 0.7,
      maxOutputTokens: 8192,
      topP: 0.9,
      topK: 40,
    };

    const result = parseConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
      defaultParamsEndpoint: EModelEndpoint.google,
    });

    expect(result).not.toBeNull();
    expect(result?.maxOutputTokens).toBe(8192);
    expect(result?.topP).toBe(0.9);
    expect(result?.topK).toBe(40);
  });

  test('should preserve promptCache when defaultParamsEndpoint is openrouter', () => {
    const conversation: Partial<TConversation> = {
      model: 'anthropic/claude-sonnet-4.6',
      temperature: 0.7,
      max_tokens: 8192,
      promptCache: true,
    };

    const result = parseConvo({
      endpoint: 'OpenRouter' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
      defaultParamsEndpoint: Providers.OPENROUTER,
    });

    expect(result).not.toBeNull();
    expect(result?.max_tokens).toBe(8192);
    expect(result?.promptCache).toBe(true);
  });

  test('should not strip fields from non-custom endpoints that already have a schema', () => {
    const conversation: Partial<TConversation> = {
      model: 'gpt-4o',
      temperature: 0.7,
      max_tokens: 4096,
      top_p: 0.9,
    };

    const result = parseConvo({
      endpoint: EModelEndpoint.openAI,
      conversation,
      defaultParamsEndpoint: EModelEndpoint.anthropic,
    });

    expect(result).not.toBeNull();
    expect(result?.max_tokens).toBe(4096);
    expect(result?.top_p).toBe(0.9);
  });

  test('should not carry bedrock region to custom endpoint without defaultParamsEndpoint', () => {
    const conversation: Partial<TConversation> = {
      model: 'gpt-4o',
      temperature: 0.7,
      region: 'us-east-1',
    };

    const result = parseConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
    });

    expect(result).not.toBeNull();
    expect(result?.temperature).toBe(0.7);
    expect(result?.region).toBeUndefined();
  });

  test('should fall back to endpointType schema when defaultParamsEndpoint is invalid', () => {
    const conversation: Partial<TConversation> = {
      model: 'gpt-4o',
      temperature: 0.7,
      max_tokens: 4096,
      maxOutputTokens: 8192,
    };

    const result = parseConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
      defaultParamsEndpoint: 'nonexistent_endpoint',
    });

    expect(result).not.toBeNull();
    expect(result?.max_tokens).toBe(4096);
    expect(result?.maxOutputTokens).toBeUndefined();
  });
});

describe('parseCompactConvo - defaultParamsEndpoint', () => {
  test('should strip maxOutputTokens for custom endpoint without defaultParamsEndpoint', () => {
    const conversation: Partial<TConversation> = {
      model: 'anthropic/claude-opus-4.5',
      temperature: 0.7,
      maxOutputTokens: 8192,
    };

    const result = parseCompactConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
    });

    expect(result).not.toBeNull();
    expect(result?.temperature).toBe(0.7);
    expect(result?.maxOutputTokens).toBeUndefined();
  });

  test('should preserve maxOutputTokens when defaultParamsEndpoint is anthropic', () => {
    const conversation: Partial<TConversation> = {
      model: 'anthropic/claude-opus-4.5',
      temperature: 0.7,
      maxOutputTokens: 8192,
      topP: 0.9,
      maxContextTokens: 50000,
    };

    const result = parseCompactConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
      defaultParamsEndpoint: EModelEndpoint.anthropic,
    });

    expect(result).not.toBeNull();
    expect(result?.maxOutputTokens).toBe(8192);
    expect(result?.topP).toBe(0.9);
    expect(result?.maxContextTokens).toBe(50000);
  });

  test('should strip iconURL even when defaultParamsEndpoint is set', () => {
    const conversation: Partial<TConversation> = {
      model: 'anthropic/claude-opus-4.5',
      iconURL: 'https://malicious.com/track.png',
      maxOutputTokens: 8192,
    };

    const result = parseCompactConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
      defaultParamsEndpoint: EModelEndpoint.anthropic,
    });

    expect(result).not.toBeNull();
    expect(result?.['iconURL']).toBeUndefined();
    expect(result?.maxOutputTokens).toBe(8192);
  });

  test('should preserve promptCache when compacting OpenRouter custom endpoints', () => {
    const conversation: Partial<TConversation> = {
      model: 'anthropic/claude-sonnet-4.6',
      promptCache: true,
      iconURL: 'https://example.com/icon.png',
    };

    const result = parseCompactConvo({
      endpoint: 'OpenRouter' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
      defaultParamsEndpoint: Providers.OPENROUTER,
    });

    expect(result).not.toBeNull();
    expect(result?.promptCache).toBe(true);
    expect(result?.['iconURL']).toBeUndefined();
  });

  test('should fall back to endpointType when defaultParamsEndpoint is null', () => {
    const conversation: Partial<TConversation> = {
      model: 'gpt-4o',
      max_tokens: 4096,
      maxOutputTokens: 8192,
    };

    const result = parseCompactConvo({
      endpoint: 'MyCustomEndpoint' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
      conversation,
      defaultParamsEndpoint: null,
    });

    expect(result).not.toBeNull();
    expect(result?.max_tokens).toBe(4096);
    expect(result?.maxOutputTokens).toBeUndefined();
  });
});

describe('parseTextParts', () => {
  test('should concatenate text parts', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'Hello' },
      { type: ContentTypes.TEXT, text: 'World' },
    ];
    expect(parseTextParts(parts)).toBe('Hello World');
  });

  test('should handle text parts with object-style text values', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: { value: 'structured text' } },
    ];
    expect(parseTextParts(parts)).toBe('structured text');
  });

  test('should include think parts by default', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'Answer:' },
      { type: ContentTypes.THINK, think: 'reasoning step' },
    ];
    expect(parseTextParts(parts)).toBe('Answer: reasoning step');
  });

  test('should skip think parts when skipReasoning is true', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.THINK, think: 'internal reasoning' },
      { type: ContentTypes.TEXT, text: 'visible answer' },
    ];
    expect(parseTextParts(parts, true)).toBe('visible answer');
  });

  test('should skip non-text/think part types', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'before' },
      { type: ContentTypes.IMAGE_FILE } as TMessageContentParts,
      { type: ContentTypes.TEXT, text: 'after' },
    ];
    expect(parseTextParts(parts)).toBe('before after');
  });

  test('should handle undefined elements in the content parts array', () => {
    const parts: Array<TMessageContentParts | undefined> = [
      { type: ContentTypes.TEXT, text: 'first' },
      undefined,
      { type: ContentTypes.TEXT, text: 'third' },
    ];
    expect(parseTextParts(parts)).toBe('first third');
  });

  test('should handle multiple consecutive undefined elements', () => {
    const parts: Array<TMessageContentParts | undefined> = [
      undefined,
      undefined,
      { type: ContentTypes.TEXT, text: 'only text' },
      undefined,
    ];
    expect(parseTextParts(parts)).toBe('only text');
  });

  test('should handle an array of all undefined elements', () => {
    const parts: Array<TMessageContentParts | undefined> = [undefined, undefined, undefined];
    expect(parseTextParts(parts)).toBe('');
  });

  test('should handle parts with missing type property', () => {
    const parts: Array<TMessageContentParts | undefined> = [
      { text: 'no type field' } as unknown as TMessageContentParts,
      { type: ContentTypes.TEXT, text: 'valid' },
    ];
    expect(parseTextParts(parts)).toBe('valid');
  });

  test('should return empty string for empty array', () => {
    expect(parseTextParts([])).toBe('');
  });

  test('should not add extra spaces when parts already have spacing', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'Hello ' },
      { type: ContentTypes.TEXT, text: 'World' },
    ];
    expect(parseTextParts(parts)).toBe('Hello World');
  });

  test('should exclude steer parts by default (generic extraction must not speak user words)', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'assistant output' },
      { type: ContentTypes.STEER, steer: 'user mid-run words' },
      { type: ContentTypes.TEXT, text: 'more output' },
    ];
    expect(parseTextParts(parts)).toBe('assistant output more output');
  });

  test('should include steer parts when includeSteer is set', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'assistant output' },
      { type: ContentTypes.STEER, steer: 'user mid-run words' },
    ];
    expect(parseTextParts(parts, false, { includeSteer: true })).toBe(
      'assistant output user mid-run words',
    );
  });

  test('should combine includeSteer with skipReasoning', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.THINK, think: 'internal reasoning' },
      { type: ContentTypes.TEXT, text: 'visible answer' },
      { type: ContentTypes.STEER, steer: 'steered words' },
    ];
    expect(parseTextParts(parts, true, { includeSteer: true })).toBe(
      'visible answer steered words',
    );
  });
});

describe('encodeEphemeralAgentId / parseEphemeralAgentId', () => {
  test('round-trips endpoint and model without a sender', () => {
    const id = encodeEphemeralAgentId({ endpoint: 'openAI', model: 'gpt-4o' });
    expect(id).toBe('openAI__gpt-4o');
    expect(parseEphemeralAgentId(id)).toEqual({
      endpoint: 'openAI',
      model: 'gpt-4o',
      sender: undefined,
      index: undefined,
    });
  });

  test('round-trips a sender', () => {
    const id = encodeEphemeralAgentId({
      endpoint: 'Together AI',
      model: 'Qwen/Qwen2.5-72B-Instruct',
      sender: 'Fast Qwen',
    });
    expect(id).toBe('Together AI__Qwen/Qwen2.5-72B-Instruct___Fast Qwen');
    expect(parseEphemeralAgentId(id)?.sender).toBe('Fast Qwen');
    expect(parseEphemeralAgentId(id)?.model).toBe('Qwen/Qwen2.5-72B-Instruct');
  });

  test('round-trips a sender alongside an index suffix', () => {
    const id = encodeEphemeralAgentId({
      endpoint: 'openAI',
      model: 'gpt-4o',
      sender: 'GPT-4o',
      index: 1,
    });
    expect(id).toBe('openAI__gpt-4o___GPT-4o____1');
    expect(parseEphemeralAgentId(id)).toEqual({
      endpoint: 'openAI',
      model: 'gpt-4o',
      sender: 'GPT-4o',
      index: 1,
    });
  });

  test('omits the sender segment for an empty sender, parsing back to undefined', () => {
    const id = encodeEphemeralAgentId({ endpoint: 'openAI', model: 'gpt-4o', sender: '' });
    expect(id).toBe('openAI__gpt-4o');
    expect(parseEphemeralAgentId(id)?.sender).toBeUndefined();
  });

  test('restores colons in the endpoint, model, and sender', () => {
    const id = encodeEphemeralAgentId({
      endpoint: 'custom',
      model: 'claude-3:opus',
      sender: 'Label:With:Colons',
    });
    expect(parseEphemeralAgentId(id)).toEqual({
      endpoint: 'custom',
      model: 'claude-3:opus',
      sender: 'Label:With:Colons',
      index: undefined,
    });
  });

  test('returns undefined for ids without the ephemeral format', () => {
    expect(parseEphemeralAgentId('agent_abc123')).toBeUndefined();
  });

  /** Characterization of known format quirks (SiblingHeader and the persisted
   *  sender both decode this format, so lock the behavior rather than change it):
   *  the parser splits on the first `___` and keeps only the next segment, and
   *  restores every `__` in the sender to `:`. */
  test('truncates a sender containing a triple underscore (known quirk)', () => {
    const id = encodeEphemeralAgentId({ endpoint: 'openAI', model: 'gpt-4o', sender: 'A___B' });
    expect(parseEphemeralAgentId(id)?.sender).toBe('A');
  });

  test('decodes a literal double underscore in a sender to a colon (known quirk)', () => {
    const id = encodeEphemeralAgentId({ endpoint: 'openAI', model: 'gpt-4o', sender: 'My__Bot' });
    expect(parseEphemeralAgentId(id)?.sender).toBe('My:Bot');
  });
});

describe('getEphemeralSender', () => {
  test('prefers modelLabel over the spec and endpoint labels', () => {
    expect(
      getEphemeralSender({
        modelLabel: 'My Label',
        specLabel: 'Spec Label',
        modelDisplayLabel: 'Endpoint Label',
      }),
    ).toBe('My Label');
  });

  test('falls back to the spec label, then the endpoint display label', () => {
    expect(
      getEphemeralSender({ specLabel: 'Spec Label', modelDisplayLabel: 'Endpoint Label' }),
    ).toBe('Spec Label');
    expect(getEphemeralSender({ modelDisplayLabel: 'Endpoint Label' })).toBe('Endpoint Label');
  });

  test('returns an empty string when no label is set', () => {
    expect(getEphemeralSender({})).toBe('');
    expect(getEphemeralSender({ modelLabel: null, specLabel: null, modelDisplayLabel: null })).toBe(
      '',
    );
  });

  /** `??` chain: an empty-string label short-circuits, preserving the exact
   *  pre-consolidation behavior of every call site. */
  test('an empty-string modelLabel short-circuits the chain', () => {
    expect(getEphemeralSender({ modelLabel: '', specLabel: 'Spec Label' })).toBe('');
  });
});

describe('isConfiguredSender', () => {
  const gptSender = getResponseSender({ endpoint: EModelEndpoint.openAI, model: 'gpt-4o' });

  test('is false without a sender to judge', () => {
    expect(isConfiguredSender({ endpoint: EModelEndpoint.openAI, model: 'gpt-4o' })).toBe(false);
    expect(isConfiguredSender({ sender: '', endpoint: EModelEndpoint.openAI })).toBe(false);
  });

  test('is false for the model-derived name the endpoint produces', () => {
    expect(
      isConfiguredSender({ sender: gptSender, endpoint: EModelEndpoint.openAI, model: 'gpt-4o' }),
    ).toBe(false);
    expect(
      isConfiguredSender({
        sender: 'Claude',
        endpoint: EModelEndpoint.anthropic,
        model: 'claude-5',
      }),
    ).toBe(false);
    expect(
      isConfiguredSender({ sender: 'Gemini', endpoint: EModelEndpoint.google, model: 'gemini-3' }),
    ).toBe(false);
  });

  test('is true for a label standing in for the model', () => {
    expect(
      isConfiguredSender({ sender: 'Acme', endpoint: EModelEndpoint.openAI, model: 'gpt-4o' }),
    ).toBe(true);
    expect(
      isConfiguredSender({ sender: 'Acme', endpoint: EModelEndpoint.anthropic, model: 'claude-5' }),
    ).toBe(true);
  });

  /* An endpoint that ignores the label writes the model-derived name as the sender, so
     equality settles the gating without listing which endpoints honour what. */
  test('follows the sender an endpoint actually wrote', () => {
    const chatGptLabel = 'Acme';
    const openAI = { endpoint: EModelEndpoint.openAI, model: 'gpt-4o', chatGptLabel };
    const anthropic = { endpoint: EModelEndpoint.anthropic, model: 'claude-5', chatGptLabel };

    expect(isConfiguredSender({ ...openAI, sender: getResponseSender(openAI) })).toBe(true);
    expect(isConfiguredSender({ ...anthropic, sender: getResponseSender(anthropic) })).toBe(false);
  });

  /* A custom endpoint's `endpoint` is its own configured name, and `getResponseSender`
     reaches its heuristics only through `endpointType`. */
  test('reads an unrecognized endpoint as a custom one', () => {
    expect(
      isConfiguredSender({ sender: gptSender, endpoint: 'Together AI', model: 'gpt-4o' }),
    ).toBe(false);
    expect(
      isConfiguredSender({ sender: 'Together', endpoint: 'Together AI', model: 'gpt-4o' }),
    ).toBe(true);
  });

  /* An agent or assistant is named by its author and `getResponseSender` has no branch
     for it, so the header shows that name whether or not the response stored a sender. */
  test('is true for an agent or assistant, stored sender or not', () => {
    expect(isConfiguredSender({ sender: 'My Agent', endpoint: EModelEndpoint.agents })).toBe(true);
    expect(
      isConfiguredSender({ sender: 'My Assistant', endpoint: EModelEndpoint.assistants }),
    ).toBe(true);
    expect(isConfiguredSender({ endpoint: EModelEndpoint.agents, model: 'gpt-4o' })).toBe(true);
  });

  /* A user turn is headed by the person who wrote it: no model to withhold, and its
     `User` sender would never match a derived name. */
  test('is false for a user turn whatever it carries', () => {
    expect(
      isConfiguredSender({
        sender: 'User',
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4o',
        isCreatedByUser: true,
      }),
    ).toBe(false);
    expect(
      isConfiguredSender({
        sender: 'User',
        endpoint: EModelEndpoint.agents,
        isCreatedByUser: true,
      }),
    ).toBe(false);
  });

  /* An endpoint that cannot be named says nothing either way, and reading that silence
     as "configured" would withhold the model from every unlabelled row it reached — one
     such row disables the hover for a whole shared transcript. */
  test('is false when there is no endpoint to derive a name from', () => {
    expect(isConfiguredSender({ sender: 'GPT-4o', model: 'gpt-4o' })).toBe(false);
    expect(isConfiguredSender({ sender: 'Acme', model: 'gpt-4o' })).toBe(false);
  });

  /* The invariant the helper exists to hold: true exactly when the sender the app wrote
     is one of the configured labels rather than a name derived from the model. */
  test('agrees with the sender chain on every label source', () => {
    const cases = [
      { endpoint: EModelEndpoint.openAI, model: 'gpt-4o' },
      { endpoint: EModelEndpoint.openAI, model: 'gpt-4o', modelLabel: 'Acme' },
      { endpoint: EModelEndpoint.openAI, model: 'gpt-4o', specLabel: 'Acme' },
      { endpoint: EModelEndpoint.openAI, model: 'gpt-4o', modelDisplayLabel: 'Acme' },
      { endpoint: EModelEndpoint.openAI, model: 'gpt-4o', chatGptLabel: 'Acme' },
      { endpoint: EModelEndpoint.anthropic, model: 'claude-5', chatGptLabel: 'Acme' },
      { endpoint: EModelEndpoint.anthropic, model: 'claude-5', modelLabel: 'Acme' },
      { endpoint: 'Together AI', endpointType: EModelEndpoint.custom, model: 'qwen' },
    ];
    for (const endpointOption of cases) {
      const { modelLabel, specLabel, modelDisplayLabel } = endpointOption as Record<string, string>;
      /** Mirrors `resolveSender`: the label chain first, `getResponseSender` behind it. */
      const sender =
        getEphemeralSender({ modelLabel, specLabel, modelDisplayLabel }) ||
        getResponseSender(endpointOption as never);

      expect(isConfiguredSender({ ...(endpointOption as never), sender })).toBe(sender === 'Acme');
    }
  });
});
