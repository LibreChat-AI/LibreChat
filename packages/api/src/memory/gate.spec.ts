import { HumanMessage, AIMessage } from '@librechat/agents/langchain/messages';
import type {
  Classifier,
  ClassificationResult,
  ClassificationRequest,
} from '~/classification/types';
import type { MemoryGateSettings } from './gate';
import { createMemoryGate, transcribeTail, MEMORY_REQUEST_QUESTION } from './gate';

const ON: MemoryGateSettings = {
  enabled: true,
  threshold: 0.25,
  categorize: false,
  categoryThreshold: 0.4,
  detectUpdates: false,
};

function stubClassifier(probability: number | Error): {
  classifier: Classifier;
  requests: ClassificationRequest[];
} {
  const requests: ClassificationRequest[] = [];
  const classifier: Classifier = {
    id: 'stub',
    model: 'stub-1',
    async classify(params: ClassificationRequest): Promise<ClassificationResult> {
      requests.push(params);
      if (probability instanceof Error) {
        throw probability;
      }
      return {
        model: 'stub-1',
        answers: { request: { type: 'boolean', probability } },
        usage: { inputTokens: 40, outputTokens: 4 },
      };
    },
  };
  return { classifier, requests };
}

const TURN = [
  new HumanMessage('I always deploy on Fridays, never on Mondays.'),
  new AIMessage('Noted.'),
];

describe('transcribeTail', () => {
  it('reads the last messages in order, labelled by role', () => {
    const text = transcribeTail(TURN, 6, 1_000);

    expect(text).toBe('human: I always deploy on Fridays, never on Mondays.\nai: Noted.');
  });

  it('keeps only the newest messages inside the window', () => {
    const messages = [
      new HumanMessage('oldest'),
      new HumanMessage('middle'),
      new HumanMessage('newest'),
    ];

    expect(transcribeTail(messages, 2, 1_000)).toBe('human: middle\nhuman: newest');
  });

  it('stays inside the character budget', () => {
    const messages = [new HumanMessage('x'.repeat(500)), new HumanMessage('y'.repeat(500))];

    expect(transcribeTail(messages, 10, 100).length).toBeLessThanOrEqual(100);
  });

  it('reads text out of structured content parts', () => {
    const message = new HumanMessage({
      content: [
        { type: 'text', text: 'I use metric units' },
        { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
      ],
    });

    expect(transcribeTail([message], 4, 1_000)).toBe('human: I use metric units');
  });

  it('skips messages with no text at all', () => {
    const empty = new HumanMessage({ content: [] });

    expect(transcribeTail([empty, new HumanMessage('real')], 4, 1_000)).toBe('human: real');
  });
});

describe('createMemoryGate', () => {
  it('is absent when the capability is off, so the caller keeps one path', () => {
    const { classifier } = stubClassifier(0.9);

    expect(createMemoryGate({ classifier, settings: { ...ON, enabled: false } })).toBeNull();
  });

  it('processes a turn that asks to remember something', async () => {
    const { classifier, requests } = stubClassifier(0.88);
    const gate = createMemoryGate({ classifier, settings: ON });

    await expect(gate?.({ messages: TURN })).resolves.toMatchObject({ process: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].questions.request).toBeDefined();
  });

  it('skips a turn that asks for no memory change', async () => {
    const { classifier } = stubClassifier(0.03);
    const gate = createMemoryGate({ classifier, settings: ON });

    await expect(gate?.({ messages: [new HumanMessage('thanks!')] })).resolves.toMatchObject({
      process: false,
    });
  });

  it('treats the threshold as inclusive', async () => {
    const { classifier } = stubClassifier(0.25);
    const gate = createMemoryGate({ classifier, settings: ON });

    await expect(gate?.({ messages: TURN })).resolves.toMatchObject({ process: true });
  });

  it('respects a stricter threshold', async () => {
    const { classifier } = stubClassifier(0.5);
    const gate = createMemoryGate({ classifier, settings: { ...ON, threshold: 0.8 } });

    await expect(gate?.({ messages: TURN })).resolves.toMatchObject({ process: false });
  });

  it('processes the turn when the judgment fails, rather than losing a memory', async () => {
    const { classifier } = stubClassifier(new Error('upstream exploded'));
    const gate = createMemoryGate({ classifier, settings: ON });

    await expect(gate?.({ messages: TURN })).resolves.toMatchObject({ process: true });
  });

  it('processes the turn when the answer comes back the wrong shape', async () => {
    const classifier: Classifier = {
      id: 'stub',
      model: 'stub-1',
      classify: async () => ({
        model: 'stub-1',
        answers: { request: { type: 'choice', choice: 'yes', confidence: 1, probabilities: {} } },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const gate = createMemoryGate({ classifier, settings: ON });

    await expect(gate?.({ messages: TURN })).resolves.toMatchObject({ process: true });
  });

  it('skips an empty turn without calling out', async () => {
    const { classifier, requests } = stubClassifier(0.9);
    const gate = createMemoryGate({ classifier, settings: ON });

    await expect(gate?.({ messages: [] })).resolves.toMatchObject({ process: false });
    expect(requests).toHaveLength(0);
  });

  it('judges the newest user message and sends earlier turns only as context', async () => {
    const { classifier, requests } = stubClassifier(0.9);
    const gate = createMemoryGate({ classifier, settings: ON });

    await gate?.({
      messages: [
        new HumanMessage('I prefer answers in Japanese from now on'),
        new AIMessage('Understood.'),
        new HumanMessage('take a screenshot of the page'),
      ],
    });

    expect(requests[0].state).toEqual({
      latest: 'take a screenshot of the page',
      conversation: 'human: I prefer answers in Japanese from now on\nai: Understood.',
    });
  });

  it('skips without calling out when the window holds no user message', async () => {
    const { classifier, requests } = stubClassifier(0.9);
    const gate = createMemoryGate({ classifier, settings: ON });

    await expect(gate?.({ messages: [new AIMessage('Hello!')] })).resolves.toMatchObject({
      process: false,
    });
    expect(requests).toHaveLength(0);
  });
});

describe('createMemoryGate usage', () => {
  it('reports what each judgment cost', async () => {
    const { classifier } = stubClassifier(0.9);
    const onUsage = jest.fn();
    const gate = createMemoryGate({ classifier, settings: ON, onUsage });

    await gate?.({ messages: TURN });

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 40, outputTokens: 4 }, 'stub-1');
  });

  it('reports nothing when the judgment fails', async () => {
    const { classifier } = stubClassifier(new Error('upstream exploded'));
    const onUsage = jest.fn();
    const gate = createMemoryGate({ classifier, settings: ON, onUsage });

    await gate?.({ messages: TURN });

    expect(onUsage).not.toHaveBeenCalled();
  });
});

describe('createMemoryGate prompt overrides', () => {
  it('uses the built-in wording when nothing is configured', async () => {
    const { classifier, requests } = stubClassifier(0.9);
    const gate = createMemoryGate({ classifier, settings: ON });

    await gate?.({ messages: TURN });

    const question = requests[0].questions.request as unknown as {
      instructions: string;
      criteria: { true: string; false: string };
    };
    expect(question.instructions).toBe(MEMORY_REQUEST_QUESTION.instructions);
    expect(question.criteria.true).toBe(MEMORY_REQUEST_QUESTION.criteria?.true);
    expect(question.criteria.false).toBe(MEMORY_REQUEST_QUESTION.criteria?.false);
  });

  it('sends operator wording instead when it is configured', async () => {
    const { classifier, requests } = stubClassifier(0.9);
    const gate = createMemoryGate({
      classifier,
      settings: {
        ...ON,
        instructions: 'Is there a dietary requirement here?',
        whenTrue: 'An allergy or a standing preference.',
        whenFalse: 'Anything about one meal only.',
      },
    });

    await gate?.({ messages: TURN });

    const question = requests[0].questions.request as unknown as {
      instructions: string;
      criteria: { true: string; false: string };
    };
    expect(question.instructions).toBe('Is there a dietary requirement here?');
    expect(question.criteria.true).toBe('An allergy or a standing preference.');
    expect(question.criteria.false).toBe('Anything about one meal only.');
  });
});

describe('memory classification', () => {
  const KEYS = ['work_context', 'preferences', 'personal'];

  function stubAnswers(answers: ClassificationResult['answers']): {
    classifier: Classifier;
    requests: ClassificationRequest[];
  } {
    const requests: ClassificationRequest[] = [];
    const classifier: Classifier = {
      id: 'stub',
      model: 'stub-1',
      async classify(params: ClassificationRequest): Promise<ClassificationResult> {
        requests.push(params);
        return { model: 'stub-1', answers, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    return { classifier, requests };
  }

  const request = { type: 'boolean' as const, probability: 0.9 };

  it('asks only the durability question by default', async () => {
    const { classifier, requests } = stubAnswers({ request });
    const gate = createMemoryGate({ classifier, settings: ON });

    await gate?.({ messages: TURN, validKeys: KEYS });

    expect(Object.keys(requests[0].questions)).toEqual(['request']);
  });

  it('adds the category and update questions to the same request', async () => {
    const { classifier, requests } = stubAnswers({ request });
    const gate = createMemoryGate({
      classifier,
      settings: { ...ON, categorize: true, detectUpdates: true },
    });

    await gate?.({ messages: TURN, validKeys: KEYS });

    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions).sort()).toEqual(['category', 'request', 'updates']);
  });

  it('skips categorization when no valid keys are configured', async () => {
    const { classifier, requests } = stubAnswers({ request });
    const gate = createMemoryGate({ classifier, settings: { ...ON, categorize: true } });

    await gate?.({ messages: TURN });

    expect(Object.keys(requests[0].questions)).toEqual(['request']);
  });

  it('suggests the winning key', async () => {
    const { classifier } = stubAnswers({
      request,
      category: {
        type: 'choice',
        choice: 'work_context',
        confidence: 0.8,
        probabilities: { work_context: 0.8, preferences: 0.15, personal: 0.05 },
      },
    });
    const gate = createMemoryGate({ classifier, settings: { ...ON, categorize: true } });

    const judgment = await gate?.({ messages: TURN, validKeys: KEYS });

    expect(judgment?.hint).toContain('work_context');
    expect(judgment?.hint).toContain('Ignore this');
  });

  it('drops a key it is not confident about', async () => {
    const { classifier } = stubAnswers({
      request,
      category: {
        type: 'choice',
        choice: 'work_context',
        confidence: 0.3,
        probabilities: { work_context: 0.35, preferences: 0.33, personal: 0.32 },
      },
    });
    const gate = createMemoryGate({ classifier, settings: { ...ON, categorize: true } });

    const judgment = await gate?.({ messages: TURN, validKeys: KEYS });

    expect(judgment?.process).toBe(true);
    expect(judgment?.hint).toBeUndefined();
  });

  it('says so when the turn changes an existing fact', async () => {
    const { classifier } = stubAnswers({
      request,
      category: {
        type: 'choice',
        choice: 'preferences',
        confidence: 0.9,
        probabilities: { preferences: 0.9, work_context: 0.05, personal: 0.05 },
      },
      updates: { type: 'boolean', probability: 0.8 },
    });
    const gate = createMemoryGate({
      classifier,
      settings: { ...ON, categorize: true, detectUpdates: true },
    });

    const judgment = await gate?.({ messages: TURN, validKeys: KEYS });

    expect(judgment?.hint).toContain('a change to what is already stored');
  });

  it('carries no hint when the turn asks for nothing', async () => {
    const { classifier } = stubAnswers({
      request: { type: 'boolean', probability: 0.01 },
      category: {
        type: 'choice',
        choice: 'personal',
        confidence: 1,
        probabilities: { personal: 1 },
      },
    });
    const gate = createMemoryGate({ classifier, settings: { ...ON, categorize: true } });

    expect(await gate?.({ messages: TURN, validKeys: KEYS })).toEqual({ process: false });
  });
});
