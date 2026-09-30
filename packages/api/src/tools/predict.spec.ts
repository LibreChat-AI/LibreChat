import { classificationSchema } from 'librechat-data-provider';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import type { LCToolRegistry, LCTool } from '@librechat/agents';
import type {
  Classifier,
  ClassificationResult,
  ClassificationRequest,
} from '~/classification/types';
import type { PredictCandidate, ToolSelectionConfig } from './predict';
import {
  predictTools,
  shortlistSize,
  namedInRequest,
  batchCandidates,
  deferredCandidates,
  predictToolsForTurn,
  RANKING_QUESTION,
  NEEDS_TOOL_QUESTION,
} from './predict';

const CONFIG: ToolSelectionConfig = {
  enabled: true,
  shortlist: 3,
  minProbability: 0.05,
  needsToolThreshold: 0.15,
  lowConfidenceExtra: 0,
  lowConfidenceBelow: 0.5,
  surfaceNamedTools: false,
  maxCatalogTools: 200,
  descriptionChars: 300,
};

const NO_MATCH = '__no_tool_fits__';

function candidates(...names: string[]): PredictCandidate[] {
  return names.map((name) => ({ name, description: `does ${name}` }));
}

/** Records the requests and answers each with the queued distributions. */
function stubClient(
  distributions: Array<Record<string, number>>,
  needsTool = 0.9,
): { classifier: Classifier; requests: ClassificationRequest[] } {
  const requests: ClassificationRequest[] = [];
  let index = 0;
  const classifier: Classifier = {
    id: 'stub',
    model: 'stub-1',
    async classify(params: ClassificationRequest): Promise<ClassificationResult> {
      requests.push(params);
      const probabilities = distributions[Math.min(index, distributions.length - 1)];
      index++;
      const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
      const answers: ClassificationResult['answers'] = {
        best_tool: {
          type: 'choice',
          choice: entries[0][0],
          confidence: entries[0][1],
          probabilities,
        },
      };
      if (params.questions.needs_tool != null) {
        answers.needs_tool = { type: 'boolean', probability: needsTool };
      }
      return {
        model: 'stub-1',
        answers,
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
  return { classifier, requests };
}

describe('batchCandidates', () => {
  it('keeps a catalog that fits in one batch', () => {
    expect(batchCandidates(candidates('a', 'b', 'c'), 200)).toHaveLength(1);
  });

  it('splits a catalog larger than the batch size', () => {
    const many = candidates(...Array.from({ length: 450 }, (_, i) => `tool_${i}`));
    const batches = batchCandidates(many, 200);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
  });

  it('never exceeds the API option ceiling, whatever the config asks for', () => {
    const many = candidates(...Array.from({ length: 600 }, (_, i) => `tool_${i}`));
    const batches = batchCandidates(many, 10_000);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(254);
    }
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(600);
  });
});

describe('predictTools', () => {
  it('returns the highest-probability tools, capped at the shortlist', async () => {
    const { classifier, requests } = stubClient([
      { alpha: 0.6, beta: 0.2, gamma: 0.12, delta: 0.05, [NO_MATCH]: 0.03 },
    ]);

    const result = await predictTools({
      classifier,
      candidates: candidates('alpha', 'beta', 'gamma', 'delta'),
      request: 'find the ranked keywords',
      config: CONFIG,
    });

    expect(result.names).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.requests).toBe(1);
    expect(result.usage.inputTokens).toBe(100);
    expect(requests[0].questions.needs_tool).toBeDefined();
  });

  it('never surfaces the no-match outcome as a tool', async () => {
    const { classifier } = stubClient([{ alpha: 0.3, [NO_MATCH]: 0.7 }]);

    const result = await predictTools({
      classifier,
      candidates: candidates('alpha'),
      request: 'do the thing',
      config: CONFIG,
    });

    expect(result.names).toEqual(['alpha']);
  });

  it('drops tools below the probability floor', async () => {
    const { classifier } = stubClient([{ alpha: 0.9, beta: 0.02, [NO_MATCH]: 0.08 }]);

    const result = await predictTools({
      classifier,
      candidates: candidates('alpha', 'beta'),
      request: 'do the thing',
      config: CONFIG,
    });

    expect(result.names).toEqual(['alpha']);
  });

  it('surfaces nothing when the turn does not need a tool', async () => {
    const { classifier } = stubClient([{ alpha: 0.9, [NO_MATCH]: 0.1 }], 0.04);

    const result = await predictTools({
      classifier,
      candidates: candidates('alpha'),
      request: 'thanks, that was helpful',
      config: CONFIG,
    });

    expect(result.names).toEqual([]);
    expect(result.needsTool).toBeCloseTo(0.04);
  });

  it('surfaces on every turn when the gate is set to zero', async () => {
    const { classifier } = stubClient([{ alpha: 0.9, [NO_MATCH]: 0.1 }], 0);

    const result = await predictTools({
      classifier,
      candidates: candidates('alpha'),
      request: 'thanks',
      config: { ...CONFIG, needsToolThreshold: 0 },
    });

    expect(result.names).toEqual(['alpha']);
  });

  it('ranks a large catalog in batches and pools the winners', async () => {
    const many = candidates(...Array.from({ length: 5 }, (_, i) => `tool_${i}`));
    const { classifier, requests } = stubClient([
      { tool_0: 0.7, tool_1: 0.2, [NO_MATCH]: 0.1 },
      { tool_2: 0.9, tool_3: 0.06, [NO_MATCH]: 0.04 },
      { tool_4: 0.5, [NO_MATCH]: 0.5 },
    ]);

    const result = await predictTools({
      classifier,
      candidates: many,
      request: 'anything',
      config: { ...CONFIG, maxCatalogTools: 2 },
    });

    expect(requests).toHaveLength(3);
    expect(result.requests).toBe(3);
    /** Pooled across batches and re-sorted by probability. */
    expect(result.names).toEqual(['tool_2', 'tool_0', 'tool_4']);
    expect(result.usage.inputTokens).toBe(300);
  });

  it('asks the needs-a-tool question only once across batches', async () => {
    const many = candidates('a', 'b', 'c', 'd');
    const { classifier, requests } = stubClient([{ a: 1 }, { c: 1 }]);

    await predictTools({
      classifier,
      candidates: many,
      request: 'anything',
      config: { ...CONFIG, maxCatalogTools: 2 },
    });

    expect(requests.filter((r) => r.questions.needs_tool != null)).toHaveLength(1);
  });

  it('truncates long descriptions to the configured budget', async () => {
    const { classifier, requests } = stubClient([{ alpha: 1 }]);

    await predictTools({
      classifier,
      candidates: [{ name: 'alpha', description: 'x'.repeat(5_000) }],
      request: 'anything',
      config: { ...CONFIG, descriptionChars: 50 },
    });

    const question = requests[0].questions.best_tool;
    const described = (question as { criteria: Record<string, string> }).criteria.alpha;
    expect(described.length).toBeLessThanOrEqual(51);
  });

  it('returns nothing, and does not call out, when there are no candidates', async () => {
    const { classifier, requests } = stubClient([{ alpha: 1 }]);

    const result = await predictTools({
      classifier,
      candidates: [],
      request: 'anything',
      config: CONFIG,
    });

    expect(result.names).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('returns nothing for an empty request', async () => {
    const { classifier, requests } = stubClient([{ alpha: 1 }]);

    const result = await predictTools({
      classifier,
      candidates: candidates('alpha'),
      request: '   ',
      config: CONFIG,
    });

    expect(result.names).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('degrades to no prediction when the judgment fails', async () => {
    const classifier: Classifier = {
      id: 'stub',
      model: 'stub-1',
      classify: async () => {
        throw new Error('upstream exploded');
      },
    };

    const result = await predictTools({
      classifier,
      candidates: candidates('alpha'),
      request: 'anything',
      config: CONFIG,
    });

    expect(result.names).toEqual([]);
  });
});

describe('deferredCandidates', () => {
  function registry(...tools: LCTool[]): LCToolRegistry {
    return new Map(tools.map((tool) => [tool.name, tool]));
  }

  it('returns only deferred tools, with their descriptions', () => {
    const result = deferredCandidates(
      registry(
        { name: 'loaded', description: 'already here', defer_loading: false },
        { name: 'hidden', description: 'behind a search', defer_loading: true },
      ),
    );

    expect(result).toEqual([{ name: 'hidden', description: 'behind a search' }]);
  });

  it('skips a tool the model already discovered this conversation', () => {
    const result = deferredCandidates(
      registry({ name: 'hidden', defer_loading: true }, { name: 'found', defer_loading: true }),
      new Set(['found']),
    );

    expect(result.map((c) => c.name)).toEqual(['hidden']);
  });

  it('handles a missing registry', () => {
    expect(deferredCandidates(undefined)).toEqual([]);
  });
});

describe('namedInRequest', () => {
  const catalog = candidates(
    'dataforseo_labs_google_ranked_keywords_mcp_AP11seo',
    'push_flex_message_mcp_linebot',
    'geocode_mcp_Maps',
  );

  it('finds a tool the user names by its base name', () => {
    expect(namedInRequest(catalog, 'no, use push_flex_message instead')).toEqual([
      'push_flex_message_mcp_linebot',
    ]);
  });

  it('ignores case', () => {
    expect(namedInRequest(catalog, 'Use GEOCODE please')).toEqual(['geocode_mcp_Maps']);
  });

  it('will not match inside a longer word', () => {
    expect(namedInRequest(catalog, 'the geocoded address was wrong')).toEqual([]);
  });

  it('returns nothing for a request that names no tool', () => {
    expect(namedInRequest(catalog, 'what is the weather today')).toEqual([]);
  });

  it('returns nothing for an empty request', () => {
    expect(namedInRequest(catalog, '')).toEqual([]);
  });

  it('keeps looking past a match inside a longer word', () => {
    expect(namedInRequest(catalog, 'geocoded badly, geocode it again')).toEqual([
      'geocode_mcp_Maps',
    ]);
  });

  it('stops at the limit when a common word matches tools on many servers', () => {
    const shared = candidates('search_mcp_A', 'search_mcp_B', 'search_mcp_C', 'search_mcp_D');

    expect(namedInRequest(shared, 'search for it', 2)).toEqual(['search_mcp_A', 'search_mcp_B']);
  });
});

describe('shortlistSize', () => {
  const widening = { ...CONFIG, shortlist: 3, lowConfidenceExtra: 3, lowConfidenceBelow: 0.5 };

  it('keeps the configured size when the ranking is confident', () => {
    expect(shortlistSize(0.9, widening)).toBe(3);
  });

  it('widens when the ranking is not confident', () => {
    expect(shortlistSize(0.3, widening)).toBe(6);
  });

  it('treats the boundary as low confidence', () => {
    expect(shortlistSize(0.5, widening)).toBe(6);
  });

  it('never widens when the extra is zero', () => {
    expect(shortlistSize(0, CONFIG)).toBe(CONFIG.shortlist);
  });
});

describe('predictTools safety behavior', () => {
  const named = { ...CONFIG, surfaceNamedTools: true };

  it('surfaces a tool the request names even when the ranking misses it', async () => {
    const { classifier } = stubClient([{ alpha: 0.95, [NO_MATCH]: 0.05 }]);

    const result = await predictTools({
      classifier,
      candidates: candidates('alpha', 'zebra_tool'),
      request: 'no, use zebra_tool for this',
      config: named,
    });

    expect(result.names).toContain('zebra_tool');
    expect(result.named).toEqual(['zebra_tool']);
  });

  it('surfaces a named tool even when the turn looks conversational', async () => {
    const { classifier } = stubClient([{ alpha: 0.9, [NO_MATCH]: 0.1 }], 0.01);

    const result = await predictTools({
      classifier,
      candidates: candidates('alpha', 'zebra_tool'),
      request: 'thanks, though next time use zebra_tool',
      config: named,
    });

    expect(result.names).toEqual(['zebra_tool']);
  });

  it('surfaces a named tool even when the judgment fails outright', async () => {
    const classifier: Classifier = {
      id: 'stub',
      model: 'stub-1',
      classify: async () => {
        throw new Error('upstream exploded');
      },
    };

    const result = await predictTools({
      classifier,
      candidates: candidates('alpha', 'zebra_tool'),
      request: 'use zebra_tool',
      config: named,
    });

    expect(result.names).toEqual(['zebra_tool']);
  });

  it('widens the shortlist when the ranking is unconfident', async () => {
    const { classifier } = stubClient([
      { a: 0.2, b: 0.19, c: 0.18, d: 0.17, e: 0.16, [NO_MATCH]: 0.1 },
    ]);

    const result = await predictTools({
      classifier,
      candidates: candidates('a', 'b', 'c', 'd', 'e'),
      request: 'something ambiguous',
      config: { ...CONFIG, shortlist: 2, lowConfidenceExtra: 2, lowConfidenceBelow: 0.5 },
    });

    expect(result.names).toHaveLength(4);
  });
});

describe('predictTools prompt overrides', () => {
  it('uses the built-in wording when nothing is configured', async () => {
    const { classifier, requests } = stubClient([{ alpha: 1 }]);

    await predictTools({
      classifier,
      candidates: candidates('alpha'),
      request: 'anything',
      config: CONFIG,
    });

    const ranking = requests[0].questions.best_tool as unknown as {
      instructions: { question: string; guidance: string };
    };
    expect(ranking.instructions.question).toBe(RANKING_QUESTION.instructions);
    expect(ranking.instructions.guidance).toBe(RANKING_QUESTION.guidance);
    expect(
      (requests[0].questions.needs_tool as unknown as { instructions: string }).instructions,
    ).toBe(NEEDS_TOOL_QUESTION.instructions);
  });

  it('sends operator wording instead when it is configured', async () => {
    const { classifier, requests } = stubClient([{ alpha: 1 }]);

    await predictTools({
      classifier,
      candidates: candidates('alpha'),
      request: 'anything',
      config: {
        ...CONFIG,
        instructions: 'Pick the tool for this support ticket.',
        guidance: 'Prefer billing tools for anything about an invoice.',
        needsToolInstructions: 'Does this ticket need a tool?',
      },
    });

    const ranking = requests[0].questions.best_tool as unknown as {
      instructions: { question: string; guidance: string };
    };
    expect(ranking.instructions.question).toBe('Pick the tool for this support ticket.');
    expect(ranking.instructions.guidance).toBe(
      'Prefer billing tools for anything about an invoice.',
    );
    expect(
      (requests[0].questions.needs_tool as unknown as { instructions: string }).instructions,
    ).toBe('Does this ticket need a tool?');
  });
});

describe('shortlistSize with unmeasured confidence', () => {
  const widening = { ...CONFIG, shortlist: 3, lowConfidenceExtra: 3, lowConfidenceBelow: 0.5 };

  it('widens when the provider cannot measure confidence', () => {
    expect(shortlistSize(null, widening)).toBe(6);
  });

  it('still respects a zero extra', () => {
    expect(shortlistSize(null, CONFIG)).toBe(CONFIG.shortlist);
  });
});

describe('predictToolsForTurn usage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports what the ranking cost, priced by the configured model', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            best_tool: {
              type: 'choice',
              choice: 'search_mcp_docs',
              confidence: 0.9,
              probabilities: { search_mcp_docs: 0.9 },
            },
            needs_tool: { type: 'noul', noul: 0.9 },
          },
          usage: { input_tokens: 512, output_tokens: 0 },
        }),
      ),
    );
    const onUsage = jest.fn();
    const registry: LCToolRegistry = new Map([
      [
        'search_mcp_docs',
        { name: 'search_mcp_docs', description: 'Search the docs', defer_loading: true } as LCTool,
      ],
    ]);

    const names = await predictToolsForTurn({
      config: classificationSchema.parse({
        enabled: true,
        provider: 'typesafe',
        toolSelection: { enabled: true },
      }),
      agents: [{ id: 'agent', toolRegistry: registry }],
      messages: [new HumanMessage('search the docs for pricing')],
      apiKey: 'test-key',
      onUsage,
    });

    expect(names).toEqual(['search_mcp_docs']);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 512, outputTokens: 0 }, 'jev-latest');
  });
});
