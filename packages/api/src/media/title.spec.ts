import { FileSources, resolveMediaConfig } from 'librechat-data-provider';
import type { AppConfig, IUser, MediaOwnerScope } from '@librechat/data-schemas';
import type { MediaConfigInput } from 'librechat-data-provider';
import type { MediaTitleGeneratorDependencies, MediaTitleInvoker, MediaTitleModel } from './title';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { RecordUsageDeps } from '~/agents/usage';
import type { MediaContext } from './context';
import {
  buildMediaTitlePrompt,
  createMediaTitleGenerator,
  createMediaTitleModelResolver,
  resolveMediaTitleTarget,
} from './title';

const scope: MediaOwnerScope = { ownerId: 'owner-1', tenantId: null };
const user = { id: 'owner-1' } as IUser;
const model: MediaTitleModel = { provider: 'openAI', clientOptions: { model: 'gpt-4o-mini' } };

function context(media?: MediaConfigInput, appConfig: Partial<AppConfig> = {}): MediaContext {
  return {
    scope,
    appConfig: { config: {}, fileStrategy: FileSources.local, ...appConfig } as AppConfig,
    config: resolveMediaConfig(media),
    canUse: true,
    canCreate: true,
    user,
  };
}

const configured = (extra: MediaConfigInput = {}): MediaConfigInput => ({
  titles: { endpoint: 'openAI', model: 'gpt-4o-mini' },
  ...extra,
});

describe('resolveMediaTitleTarget', () => {
  it('returns nothing when titles are disabled', () => {
    expect(
      resolveMediaTitleTarget(
        context({ titles: { enabled: false, endpoint: 'openAI', model: 'gpt-4o-mini' } }),
      ),
    ).toBeUndefined();
  });

  it('returns nothing without an endpoint anywhere so unconfigured deployments keep prompt titles', () => {
    expect(resolveMediaTitleTarget(context())).toBeUndefined();
    expect(resolveMediaTitleTarget(context({ titles: { model: 'gpt-4o-mini' } }))).toBeUndefined();
  });

  it('uses the explicit media endpoint, model, prompt and timeout', () => {
    expect(
      resolveMediaTitleTarget(
        context({
          titles: {
            endpoint: 'openAI',
            model: 'gpt-4o-mini',
            prompt: 'Name {prompt}',
            timeoutMs: 5,
          },
        }),
      ),
    ).toEqual({ endpoint: 'openAI', model: 'gpt-4o-mini', prompt: 'Name {prompt}', timeoutMs: 5 });
  });

  it('falls back to the global chat title endpoint and model', () => {
    expect(
      resolveMediaTitleTarget(
        context(
          {},
          {
            endpoints: { all: { titleEndpoint: 'anthropic', titleModel: 'claude-3-5-haiku' } },
          },
        ),
      ),
    ).toMatchObject({ endpoint: 'anthropic', model: 'claude-3-5-haiku' });
  });

  it('ignores current_model and reads the named or custom endpoint titleModel instead', () => {
    expect(
      resolveMediaTitleTarget(
        context(
          { titles: { endpoint: 'openAI', model: 'current_model' } },
          {
            endpoints: {
              all: { titleModel: 'current_model' },
              openAI: { titleModel: 'gpt-4o-mini' },
            },
          },
        ),
      ),
    ).toMatchObject({ endpoint: 'openAI', model: 'gpt-4o-mini' });
    expect(
      resolveMediaTitleTarget(
        context({ titles: { endpoint: 'Fixture' } }, {
          endpoints: {
            custom: [
              {
                name: 'Fixture',
                apiKey: 'secret',
                baseURL: 'http://127.0.0.1:9/v1',
                titleModel: 'fixture-mini',
              },
            ],
          },
        } as Partial<AppConfig>),
      ),
    ).toMatchObject({ endpoint: 'Fixture', model: 'fixture-mini' });
    expect(
      resolveMediaTitleTarget(
        context(
          { titles: { endpoint: 'openAI' } },
          { endpoints: { all: { titleModel: 'current_model' } } },
        ),
      ),
    ).toBeUndefined();
  });
});

describe('buildMediaTitlePrompt', () => {
  it('words the default prompt per operation and ends with the request', () => {
    const image = buildMediaTitlePrompt({ prompt: 'A lake at dawn', operation: 'image.generate' });
    expect(image).toContain('5 words or less for an image generation request');
    expect(image).toContain('plain text only, no markdown or bullets');
    expect(image.endsWith('\nA lake at dawn')).toBe(true);
    expect(buildMediaTitlePrompt({ prompt: 'x', operation: 'image.edit' })).toContain(
      'an image editing request',
    );
    expect(buildMediaTitlePrompt({ prompt: 'x', operation: 'video.generate' })).toContain(
      'a video generation request',
    );
  });

  it('substitutes every placeholder literally and appends the prompt when a template has none', () => {
    expect(
      buildMediaTitlePrompt({
        prompt: 'Costs $& more',
        operation: 'image.generate',
        template: 'Title for {prompt} ({prompt})',
      }),
    ).toBe('Title for Costs $& more (Costs $& more)');
    expect(
      buildMediaTitlePrompt({ prompt: 'A lake', operation: 'video.generate', template: 'Name it' }),
    ).toBe('Name it\n\nA lake');
  });
});

describe('createMediaTitleModelResolver', () => {
  const db = {
    getUserKey: async () => {
      throw new Error('unexpected user key lookup');
    },
    getUserKeyValues: async () => {
      throw new Error('unexpected user key lookup');
    },
  };

  it('returns nothing without a request user', async () => {
    const resolve = createMediaTitleModelResolver({ db });
    expect(
      await resolve({
        context: { ...context(configured()), user: undefined },
        target: { endpoint: 'openAI', model: 'gpt-4o-mini', timeoutMs: 1_000 },
      }),
    ).toBeUndefined();
  });

  it('resolves a configured custom endpoint into sanitized, non-streaming client options', async () => {
    const resolve = createMediaTitleModelResolver({ db });
    const resolved = await resolve({
      context: context({ titles: { endpoint: 'Fixture', model: 'fixture-mini' } }, {
        endpoints: {
          custom: [
            {
              name: 'Fixture',
              apiKey: 'secret',
              baseURL: 'http://127.0.0.1:9/v1',
              tokenConfig: { 'fixture-mini': { prompt: 2, completion: 4, context: 1000 } },
            },
          ],
        },
      } as Partial<AppConfig>),
      target: { endpoint: 'Fixture', model: 'fixture-mini', timeoutMs: 1_000 },
    });
    expect(resolved?.provider).toBe('openAI');
    expect(resolved?.clientOptions).toMatchObject({ model: 'fixture-mini' });
    expect(resolved?.clientOptions).not.toHaveProperty('streaming');
    expect(resolved?.clientOptions).not.toHaveProperty('maxTokens');
    expect(resolved?.endpointTokenConfig).toMatchObject({
      'fixture-mini': { prompt: 2, completion: 4, context: 1000 },
    });
  });
});

describe('createMediaTitleGenerator', () => {
  const threadId = 'thread-1';
  const prompt = 'A quiet observatory under the stars';
  const currentTitle = 'A quiet observatory under the stars';

  function repository(title = currentTitle) {
    const thread = { title, version: 1 };
    let claimed = false;
    const calls: Array<{ expectedTitle: string; title: string }> = [];
    return {
      thread,
      calls,
      claimMediaThreadTitle: async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      replaceMediaThreadTitle: async (input: {
        scope: MediaOwnerScope;
        threadId: string;
        expectedTitle: string;
        title: string;
      }) => {
        calls.push({ expectedTitle: input.expectedTitle, title: input.title });
        if (input.threadId !== threadId || thread.title !== input.expectedTitle) {
          return false;
        }
        thread.title = input.title;
        thread.version += 1;
        return true;
      },
    };
  }

  const reply =
    (text: string, usage?: UsageMetadata): MediaTitleInvoker =>
    async () => ({ text, usage });

  function generator(
    invoke: MediaTitleInvoker,
    overrides: Partial<MediaTitleGeneratorDependencies> = {},
  ) {
    const repo = repository();
    const scopes: MediaOwnerScope[] = [];
    const errors: Error[] = [];
    const resolved: MediaTitleModel[] = [];
    const generate = createMediaTitleGenerator({
      repository: repo,
      resolveModel: async () => {
        resolved.push(model);
        return model;
      },
      invoke,
      withScope: async (requested, operation) => {
        scopes.push(requested);
        return operation();
      },
      log: (message, error) => {
        errors.push(error ?? new Error(message));
      },
      ...overrides,
    });
    return { generate, repo, scopes, errors, resolved };
  }

  const request = (media: MediaConfigInput = configured(), appConfig?: Partial<AppConfig>) => ({
    context: context(media, appConfig),
    jobId: 'job-1',
    threadId,
    prompt,
    operation: 'image.generate' as const,
    currentTitle,
    signal: new AbortController().signal,
  });

  it.each([
    [
      '<think>naming...\nstill thinking</think>\n “Quiet Observatory Sketch.” \n',
      'Quiet Observatory Sketch',
    ],
    ['* **Hot-Air Balloon**\n* alt', 'Hot-Air Balloon'],
    ['**Retro-futuristic**', 'Retro-futuristic'],
    ['\n\n# _Paper City_\nAnother option', 'Paper City'],
    ['- `Cloud Castle`', 'Cloud Castle'],
    ['1. __Ocean City__', 'Ocean City'],
  ])('applies the first plain title inside the owner scope: %s', async (text, title) => {
    const { generate, repo, scopes, errors } = generator(reply(text));
    await expect(generate(request())).resolves.toBe(title);
    expect(repo.thread).toEqual({ title, version: 2 });
    expect(repo.calls).toEqual([{ expectedTitle: currentTitle, title }]);
    expect(scopes).toEqual([scope, scope]);
    expect(errors).toEqual([]);
  });

  it('bounds the generated title to the configured limit without splitting characters', async () => {
    const { generate, repo } = generator(reply('Quiet 🌲 Observatory'));
    await expect(generate(request(configured({ limits: { maxTitleChars: 8 } })))).resolves.toBe(
      'Quiet 🌲',
    );
    expect(repo.thread.title).toBe('Quiet 🌲');
    const { generate: split, repo: splitRepo } = generator(reply('Quiet 🌲 Observatory'));
    await expect(split(request(configured({ limits: { maxTitleChars: 7 } })))).resolves.toBe(
      'Quiet',
    );
    expect(splitRepo.thread.title).toBe('Quiet');
  });

  it('skips empty replies and titles equal to the prompt-derived one', async () => {
    const empty = generator(reply('  <think>nothing</think>  '));
    await expect(empty.generate(request())).resolves.toBeUndefined();
    expect(empty.repo.calls).toEqual([]);
    const same = generator(reply(`"${currentTitle}"`));
    await expect(same.generate(request())).resolves.toBeUndefined();
    expect(same.repo.calls).toEqual([]);
    expect([...empty.errors, ...same.errors]).toEqual([]);
  });

  it('leaves a thread alone once the user renamed it', async () => {
    const repo = repository('My observatory');
    const { generate } = generator(reply('Quiet Observatory'), { repository: repo });
    await expect(generate(request())).resolves.toBeUndefined();
    expect(repo.thread).toEqual({ title: 'My observatory', version: 1 });
  });

  it('does nothing without a resolvable target or model', async () => {
    let invoked = 0;
    const invoke: MediaTitleInvoker = async () => {
      invoked += 1;
      return { text: 'Never' };
    };
    const disabled = generator(invoke);
    await expect(
      disabled.generate(request({ titles: { enabled: false } })),
    ).resolves.toBeUndefined();
    expect(disabled.resolved).toEqual([]);
    const noModel = generator(invoke, { resolveModel: async () => undefined });
    await expect(noModel.generate(request())).resolves.toBeUndefined();
    expect(invoked).toBe(0);
    expect(noModel.repo.calls).toEqual([]);
  });

  it('logs and swallows invoker failures', async () => {
    const failure = new Error('provider unavailable');
    const { generate, repo, errors } = generator(async () => {
      throw failure;
    });
    await expect(generate(request())).resolves.toBeUndefined();
    expect(errors).toEqual([failure]);
    expect(repo.calls).toEqual([]);
  });

  it('aborts the model call at the configured timeout', async () => {
    const { generate, repo, errors } = generator(
      (_model, _prompt, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    await expect(
      generate(request({ titles: { endpoint: 'openAI', model: 'gpt-4o-mini', timeoutMs: 1 } })),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/timeout/i);
    expect(repo.calls).toEqual([]);
  });

  it('records title usage against the owner and thread when billing deps are supplied', async () => {
    const spendTokens = jest.fn(async () => undefined);
    const usage: RecordUsageDeps = { spendTokens, spendStructuredTokens: jest.fn() };
    const { generate } = generator(
      reply('Quiet Observatory', { input_tokens: 12, output_tokens: 4 }),
      { usage },
    );
    await expect(generate(request())).resolves.toBe('Quiet Observatory');
    expect(spendTokens).toHaveBeenCalledTimes(1);
    expect(spendTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        context: 'title',
        user: scope.ownerId,
        conversationId: threadId,
        model: 'gpt-4o-mini',
      }),
      { promptTokens: 12, completionTokens: 4 },
    );
    const skipped = generator(reply(currentTitle, { input_tokens: 9, output_tokens: 2 }), {
      usage,
    });
    await expect(skipped.generate(request())).resolves.toBeUndefined();
    expect(spendTokens).toHaveBeenCalledTimes(2);
    const unmetered = generator(reply('Quiet Observatory'), { usage });
    await expect(unmetered.generate(request())).resolves.toBe('Quiet Observatory');
    expect(spendTokens).toHaveBeenCalledTimes(2);
  });

  it('does not reserve or invoke a title when shutdown interrupts model resolution', async () => {
    const controller = new AbortController();
    const invoke = jest.fn().mockResolvedValue({ text: 'Quiet Observatory' });
    const ledger = admission();
    const { generate, repo } = generator(invoke, {
      resolveModel: async () => {
        controller.abort();
        return model;
      },
      admission: ledger,
      usage: paidUsage(),
    });
    await generate({ ...paidRequest(), signal: controller.signal });
    expect(ledger.reserveBalance).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(repo.calls).toEqual([]);
  });

  it('accounts for a late response after cancellation without replacing the title', async () => {
    const controller = new AbortController();
    const ledger = admission();
    const usage = paidUsage();
    const { generate, repo } = generator(
      async () => {
        controller.abort();
        return { text: 'Quiet Observatory', usage: { input_tokens: 10, output_tokens: 2 } };
      },
      { admission: ledger, usage },
    );
    await generate({ ...paidRequest(), signal: controller.signal });
    expect(usage.spendTokens).toHaveBeenCalledTimes(1);
    expect(ledger.releaseBalanceReservation).toHaveBeenCalledTimes(1);
    expect(repo.calls).toEqual([]);
  });

  it('records paid usage even when title publication throws', async () => {
    const spendTokens = jest.fn().mockResolvedValue(undefined);
    const publicationError = new Error('title write unavailable');
    const repo = {
      ...repository(),
      replaceMediaThreadTitle: jest.fn().mockRejectedValue(publicationError),
    };
    const { generate, errors } = generator(
      reply('Quiet Observatory', { input_tokens: 10, output_tokens: 2 }),
      {
        repository: repo,
        usage: { spendTokens, spendStructuredTokens: jest.fn() },
      },
    );
    await expect(generate(request())).resolves.toBeUndefined();
    expect(spendTokens).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([publicationError]);
    await generate(request());
    expect(spendTokens).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      provider: 'openAI',
      input_tokens: 100,
      output_tokens: 5,
      total_tokens: 125,
      input_token_details: { cache_read: 60, cache_creation: 20 },
      expected: { promptTokens: { input: 20, read: 60, write: 20 }, completionTokens: 25 },
    },
    {
      provider: 'bedrock',
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 105,
      input_token_details: { cache_read: 60, cache_creation: 20 },
      expected: { promptTokens: { input: 20, read: 60, write: 20 }, completionTokens: 5 },
    },
  ])(
    'retains provider-aware cache and total metadata for $provider',
    async ({ expected, ...usage }) => {
      const spendStructuredTokens = jest.fn().mockResolvedValue(undefined);
      const endpointTokenConfig = { 'gpt-4o-mini': { prompt: 2, completion: 3, context: 1000 } };
      const { generate } = generator(reply('Quiet Observatory', usage), {
        resolveModel: async () => ({ ...model, endpointTokenConfig }),
        usage: { spendTokens: jest.fn(), spendStructuredTokens },
      });
      await generate(request());
      expect(spendStructuredTokens).toHaveBeenCalledWith(
        expect.objectContaining({ endpointTokenConfig }),
        expected,
      );
    },
  );

  const admission = () => ({
    reserveBalance: jest.fn().mockResolvedValue({ reserved: true, balance: 10_000 }),
    renewBalanceReservation: jest.fn().mockResolvedValue(undefined),
    releaseBalanceReservation: jest.fn().mockResolvedValue(undefined),
  });
  const paidUsage = (): RecordUsageDeps => ({
    spendTokens: jest.fn().mockResolvedValue(undefined),
    spendStructuredTokens: jest.fn().mockResolvedValue(undefined),
    pricing: { getMultiplier: () => 1, getCacheMultiplier: () => 1 },
  });
  const paidRequest = () => request(configured(), { balance: { enabled: true } });

  it('skips an unfunded title without claiming or invoking it', async () => {
    const ledger = admission();
    ledger.reserveBalance.mockResolvedValue({ reserved: false, balance: 0 });
    const invoke = jest.fn().mockResolvedValue({ text: 'Quiet Observatory' });
    const claim = jest.fn().mockResolvedValue(true);
    const { generate } = generator(invoke, {
      admission: ledger,
      usage: paidUsage(),
      repository: { ...repository(), claimMediaThreadTitle: claim },
    });
    await generate(paidRequest());
    expect(ledger.reserveBalance).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(ledger.releaseBalanceReservation).not.toHaveBeenCalled();
  });

  it('estimates title output for admission without overriding the resolved model options', async () => {
    const ledger = admission();
    const usage = paidUsage();
    const getMultiplier = jest.fn().mockReturnValue(2);
    usage.pricing!.getMultiplier = getMultiplier;
    const endpointTokenConfig = { 'gpt-4o-mini': { prompt: 2, completion: 2, context: 1000 } };
    const invoke = jest.fn().mockResolvedValue({
      text: 'Quiet Observatory',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const { generate } = generator(invoke, {
      admission: ledger,
      usage,
      resolveModel: async () => ({ ...model, endpointTokenConfig }),
    });
    await generate(paidRequest());
    const held = ledger.reserveBalance.mock.calls[0][0];
    expect(held.amount).toBeGreaterThan(128 * 2);
    expect(getMultiplier).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenType: 'completion',
        endpointTokenConfig,
      }),
    );
    expect(invoke.mock.calls[0][0].clientOptions).toEqual(model.clientOptions);
    expect(ledger.releaseBalanceReservation).toHaveBeenCalledWith({
      user: scope.ownerId,
      reservationId: held.reservationId,
      amount: held.amount,
    });
  });

  it('permits one invocation for concurrent claims and releases every admitted reservation', async () => {
    const ledger = admission();
    const invoke = jest.fn().mockResolvedValue({ text: 'Quiet Observatory' });
    const { generate } = generator(invoke, { admission: ledger, usage: paidUsage() });
    await Promise.all([generate(paidRequest()), generate(paidRequest()), generate(paidRequest())]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ledger.releaseBalanceReservation).toHaveBeenCalledTimes(3);
  });

  it('holds the title reservation until a non-bulk usage write settles', async () => {
    const ledger = admission();
    let complete!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const usage = {
      ...paidUsage(),
      spendTokens: jest.fn(() => {
        started();
        return writing;
      }),
    };
    const { generate } = generator(
      reply('Quiet Observatory', { input_tokens: 10, output_tokens: 2 }),
      {
        admission: ledger,
        usage,
      },
    );
    const work = generate(paidRequest());
    await entered;
    expect(ledger.releaseBalanceReservation).not.toHaveBeenCalled();
    complete();
    await work;
    expect(ledger.releaseBalanceReservation).toHaveBeenCalledTimes(1);
  });

  it.each(['claim', 'invoke', 'publication', 'abort'] as const)(
    'releases the title reservation after %s failure',
    async (step) => {
      const ledger = admission();
      const controller = new AbortController();
      const fail = async () => {
        throw new Error('failure');
      };
      const repo = repository();
      const invoke: MediaTitleInvoker = step === 'invoke' ? fail : reply('Quiet Observatory');
      if (step === 'claim') repo.claimMediaThreadTitle = fail;
      if (step === 'publication') repo.replaceMediaThreadTitle = fail;
      if (step === 'abort')
        repo.claimMediaThreadTitle = async () => {
          controller.abort();
          return true;
        };
      const { generate } = generator(invoke, {
        admission: ledger,
        usage: paidUsage(),
        repository: repo,
      });
      await generate({ ...paidRequest(), signal: controller.signal });
      expect(ledger.releaseBalanceReservation).toHaveBeenCalledTimes(1);
    },
  );
});
