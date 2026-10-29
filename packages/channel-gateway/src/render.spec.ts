import type { ChannelArtifact, ChannelRunView } from 'librechat-data-provider';
import {
  chunkText,
  safeMrkdwn,
  rendererVersion,
  makeSlackPlan,
  validArtifact,
  renderAgentAnswer,
  supportedRenderer,
  presentationFormat,
  durableSlackMessage,
  renderSlackDocument,
  safeSummarySessionURL,
  accountingPriceDescription,
} from './render';

function run(): ChannelRunView {
  return {
    runId: 'run-12345678',
    channelId: 'channel-1',
    revision: 'revision-1',
    state: 'delivering',
    sequence: 1,
    admission: {
      actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
      eventId: 'event-1',
      externalChannelId: 'C1',
      externalThreadKey: 'C1:123.456',
      externalMessageKey: 'C1:123.457',
      input: 'hello',
    },
    cancellationRequested: false,
    receipts: [],
    snapshot: {
      text: 'Hello **world**',
      status: 'completed',
      elapsedMs: 1250,
      responseId: 'resp_1',
    },
  };
}

const artifact: ChannelArtifact = {
  artifactId: 'opaque-file-1',
  filename: 'report.txt',
  mediaType: 'text/plain',
  bytes: 10,
  sha256: 'a'.repeat(64),
};

describe('Slack answer rendering', () => {
  it('converts prose but leaves code syntax untouched', () => {
    expect(
      safeMrkdwn(
        '# Title\n**bold** __bold__ [site](https://example.com/a?x=1&y=2)\n```js\n**literal**\n```',
      ),
    ).toBe(
      '*Title*\n*bold* *bold* <https://example.com/a?x=1&amp;y=2|site>\n```js\n**literal**\n```',
    );
  });

  it('escapes native mentions and rejects unsafe links without dropping the label', () => {
    const rendered = safeMrkdwn(
      '<!here> <@U1> <#C1> [bad](javascript:alert) [credentials](https://user:secret@example.com) [safe](https://example.com)',
    );
    expect(rendered).toContain('&lt;!here&gt; &lt;@U1&gt; &lt;#C1&gt; bad credentials');
    expect(rendered).toContain('<https://example.com|safe>');
    expect(rendered).not.toContain('javascript:');
    expect(rendered).not.toContain('secret');
    for (const mention of ['<!here>', '<@U1>', '<#C1>']) {
      const message = renderAgentAnswer(mention)[0];
      expect(message.blocks?.[0].type).toBe('section');
      expect(message.text).not.toContain(mention);
    }
  });

  it('uses native markdown only for bounded final answers', () => {
    const messages = renderAgentAnswer('# Title\n\n**Bold** and [site](https://example.com)');
    expect(messages).toHaveLength(1);
    expect(messages[0].blocks).toEqual([
      { type: 'markdown', text: '# Title\n\n**Bold** and [site](https://example.com)' },
    ]);
    expect(renderAgentAnswer('a'.repeat(12001))[0].blocks?.[0].type).toBe('section');
  });

  it('renders headings, tables, code and dividers without losing the fallback', () => {
    const messages = renderSlackDocument(
      '# Title\n\n| A | B |\n| --- | :---: |\n| 1 | 2 |\n\n```ts\nconst x = "<@U1>";\n```\n\n---\n\nDone',
    );
    expect(messages.flatMap((message) => message.blocks?.map((block) => block.type))).toEqual([
      'header',
      'table',
      'rich_text',
      'divider',
      'section',
    ]);
    expect(messages.map((message) => message.text).join('\n')).toContain(
      'const x = "&lt;@U1&gt;";',
    );
    expect(
      messages.flatMap((message) => message.blocks).find((block) => block?.type === 'rich_text'),
    ).toEqual({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_preformatted',
          elements: [{ type: 'text', text: 'const x = "<@U1>";' }],
        },
      ],
    });
  });

  it('falls back to prose for malformed and oversized tables', () => {
    for (const value of [
      '| A | B |\n| --- | --- |\n| only one |',
      '| A |\n| --- |\n' + '| row |\n'.repeat(21),
    ]) {
      expect(
        renderSlackDocument(value)
          .flatMap((message) => message.blocks)
          .some((block) => block?.type === 'table'),
      ).toBe(false);
    }
  });

  it('bounds UTF-8 chunks and reopens long code fences', () => {
    const value = '🙂'.repeat(5000);
    expect(chunkText(value, 2800).join('')).toBe(value);
    for (const chunk of chunkText(value, 2800)) {
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(2800);
      expect(chunk).not.toContain('\ufffd');
    }
    const messages = renderSlackDocument('```\n' + value + '\n```');
    const blocks = messages.flatMap((message) => message.blocks ?? []);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.type).toBe('rich_text');
    }
    for (const message of messages) {
      expect(Buffer.byteLength(message.text)).toBeLessThanOrEqual(39000);
      expect((message.text.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it('retains empty fences and obeys the forty-block payload budget', () => {
    for (const value of ['```\n```', '# heading\n\n'.repeat(100)]) {
      for (const message of renderSlackDocument(value)) {
        expect((message.blocks ?? []).length).toBeLessThanOrEqual(40);
      }
      const view = run();
      view.snapshot!.text = value;
      for (const part of makeSlackPlan(view).parts) {
        expect(() => durableSlackMessage(part, rendererVersion)).not.toThrow();
      }
    }
  });
});

describe('immutable Slack plans', () => {
  it('creates deterministic parts, feedback and persisted final presentation', () => {
    const view = run();
    const plan = makeSlackPlan(view, true);
    expect(plan).toEqual(makeSlackPlan(view, true));
    expect(plan.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.rendererVersion).toBe(rendererVersion);
    expect(plan.parts[0].operationId).toBe('run-12345678:reply:0');
    expect(plan.parts[0].required).toBe(true);
    expect(plan.parts[0].presentation?.format).toBe(presentationFormat);
    expect(durableSlackMessage(plan.parts[0], rendererVersion).blocks?.at(-1)?.type).toBe(
      'context_actions',
    );
    const saved = structuredClone(plan.parts[0]);
    view.snapshot!.text = 'Changed after the operation started';
    expect(durableSlackMessage(saved, rendererVersion).text).toContain('Hello *world*');
    expect(durableSlackMessage(saved, rendererVersion).text).not.toContain('Changed');
    view.plan = plan;
    expect(() => makeSlackPlan(view, true)).toThrow('must not be regenerated');
  });

  it.each(['slack-structured-v2', 'slack-structured-v3', 'slack-structured-v4'])(
    'recovers %s without rerendering',
    (version) => {
      const part = makeSlackPlan(run()).parts[0];
      expect(durableSlackMessage(part, version).text).toBe(part.text);
      expect(supportedRenderer(version)).toBe(true);
    },
  );

  it('preserves persisted Unicode payloads counted by code points, not UTF-16 units', () => {
    const part = makeSlackPlan(run()).parts[0];
    part.presentation = {
      format: presentationFormat,
      payload: JSON.stringify([{ type: 'markdown', text: '🙂'.repeat(12000) }]),
    };
    expect(durableSlackMessage(part, 'slack-structured-v3').blocks).toHaveLength(1);
  });

  it('recovers legacy text but refuses structured presentation with a legacy or unknown renderer', () => {
    const part = makeSlackPlan(run()).parts[0];
    expect(() => durableSlackMessage(part, 'slack-text-v1')).toThrow();
    expect(() => durableSlackMessage(part, 'future')).toThrow();
    delete part.presentation;
    expect(durableSlackMessage(part, 'slack-text-v1')).toEqual({ text: part.text });
    expect(supportedRenderer('slack-text-v1')).toBe(true);
    expect(supportedRenderer('future')).toBe(false);
  });

  it.each([
    'null',
    '{}',
    '[]',
    '[{}]',
    '[{"type":"unknown"}]',
    '[{"type":"divider","url":"https://example.com"}]',
    '[{"type":"section","text":{"type":"plain_text","text":"wrong"}}]',
    '[{"type":"rich_text","elements":[]}]',
    '[{"type":"table","rows":[[{"type":"raw_text","text":"x"}],[]]}]',
    '[{"type":"divider"}] {}',
    ' '.repeat(64001),
  ])('rejects corrupt or unsupported persisted block shapes', (payload) => {
    const part = makeSlackPlan(run()).parts[0];
    part.presentation = { format: presentationFormat, payload };
    expect(() => durableSlackMessage(part, rendererVersion)).toThrow();
  });

  it('strips provider diagnostics on failures and cancellation and does not attach their artifacts', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const view = run();
      view.snapshot!.status = status;
      view.snapshot!.text = 'secret diagnostic';
      view.snapshot!.artifacts = [artifact];
      const plan = makeSlackPlan(view, true);
      expect(plan.parts.some((part) => part.kind === 'artifact')).toBe(false);
      expect(plan.parts.map((part) => part.text).join()).not.toContain('secret diagnostic');
      expect(
        durableSlackMessage(plan.parts[0], rendererVersion).blocks?.some(
          (block) => block.type === 'context_actions',
        ),
      ).toBe(false);
    }
  });

  it('requires a terminal snapshot and a completed Responses cursor', () => {
    const view = run();
    view.snapshot!.status = 'running';
    expect(() => makeSlackPlan(view)).toThrow('terminal');
    view.snapshot!.status = 'completed';
    delete view.snapshot!.responseId;
    expect(() => makeSlackPlan(view)).toThrow('cursor');
  });

  it('handles empty answers and unavailable attachments without claiming success text', () => {
    const view = run();
    view.snapshot!.text = '   ';
    view.snapshot!.artifactsUnavailable = true;
    const plan = makeSlackPlan(view, true);
    expect(plan.parts[0].text).toContain('finished without a text reply');
    expect(plan.parts[0].text).toContain('Attachments are unavailable');
    expect(
      durableSlackMessage(plan.parts[0], rendererVersion).blocks?.some(
        (block) => block.type === 'context_actions',
      ),
    ).toBe(false);
  });

  it('bounds, deduplicates and validates optional artifact operations', () => {
    const view = run();
    view.snapshot!.artifacts = [
      artifact,
      artifact,
      { ...artifact, artifactId: 'bad', filename: '../secret' },
    ];
    const plan = makeSlackPlan(view);
    expect(plan.parts.filter((part) => part.kind === 'artifact')).toEqual([
      {
        operationId: 'run-12345678:artifact:0',
        kind: 'artifact',
        required: false,
        artifactId: artifact.artifactId,
        text: artifact.filename,
      },
    ]);
    expect(plan.parts.find((part) => part.operationId.endsWith(':artifact-status'))?.required).toBe(
      false,
    );
    expect(
      plan.parts.find((part) => part.operationId.endsWith(':artifact-unavailable')),
    ).toBeDefined();
    for (const filename of ['../x', 'a\\b', 'a\u0000b', 'a\u200eb']) {
      expect(validArtifact({ ...artifact, filename })).toBe(false);
    }
    expect(validArtifact({ ...artifact, bytes: 50 * 1024 * 1024 + 1 })).toBe(false);
    expect(validArtifact({ ...artifact, sha256: 'A'.repeat(64) })).toBe(false);
  });
});

describe('accounting and actor-lane summary', () => {
  it('never presents partial costs or malformed values as the run total', () => {
    const accounting = {
      status: 'available',
      currency: 'USD',
      amount: '0.05',
      basis: 'provider_reported',
      coverage: 'complete',
      reason: 'priced',
      calls: [],
    } as const;
    expect(accountingPriceDescription({ ...accounting, calls: [] })).toBe(
      '$0.05 USD (provider reported)',
    );
    for (const value of ['-1', 'NaN', '1e8', '1\n<!here>', '00.1']) {
      expect(accountingPriceDescription({ ...accounting, amount: value, calls: [] })).toBe(
        'Cost unavailable',
      );
    }
    expect(accountingPriceDescription({ ...accounting, coverage: 'partial', calls: [] })).toBe(
      'Cost unavailable',
    );
  });

  it('qualifies partial thread totals and only renders backend-authorized session URLs', () => {
    const view = run();
    view.sequence = 3;
    view.snapshot!.summary = {
      version: 1,
      scope: 'actor_lane',
      includesCurrent: true,
      throughSequence: 3,
      expectedRuns: 3,
      observedRuns: 2,
      priorRuns: 1,
      costUSD: {
        coverage: 'partial',
        coveredRuns: 2,
        knownValue: '0.04',
        basis: 'application_billing',
      },
      elapsedMs: { coverage: 'partial', coveredRuns: 1, knownValue: 5000 },
      tokens: { coverage: 'unavailable', coveredRuns: 0 },
      session: { url: 'https://chat.example.com/c/session' },
    };
    const part = makeSlackPlan(view).parts[0];
    expect(part.text).toContain('known $0.04 USD (application billing; partial 2/3 runs)');
    expect(part.text).toContain('known 5.0s processing (partial 1/3)');
    expect(part.text).toContain('tokens unavailable');
    const context = durableSlackMessage(part, rendererVersion).blocks?.find(
      (block) => block.type === 'context',
    );
    expect(JSON.stringify(context)).toContain('View session');
    expect(JSON.stringify(context)).toContain('known $0.04');
    view.snapshot!.summary.throughSequence = 4;
    expect(makeSlackPlan(view).parts[0].text).toContain('Your thread: totals unavailable');
  });

  it.each([
    'http://example.com/session',
    'https://localhost/session',
    'https://foo.local/session',
    'https://127.0.0.1/session',
    'https://[::1]/session',
    'https://user:secret@example.com/session',
    'https://example.com/session?token=secret',
    'https://example.com/session#secret',
    'https://example.com/evil|mention',
  ])('rejects unsafe session URL %s', (url) => {
    expect(safeSummarySessionURL(url)).toBe(false);
  });

  it('does not repeat one-run totals in the visible footer', () => {
    const view = run();
    view.snapshot!.summary = {
      version: 1,
      scope: 'actor_lane',
      includesCurrent: true,
      throughSequence: 1,
      expectedRuns: 1,
      observedRuns: 1,
      priorRuns: 0,
      costUSD: { coverage: 'unavailable', coveredRuns: 0 },
      elapsedMs: { coverage: 'unavailable', coveredRuns: 0 },
      tokens: { coverage: 'unavailable', coveredRuns: 0 },
    };
    const message = durableSlackMessage(makeSlackPlan(view).parts[0], rendererVersion);
    expect(message.text).toContain('Your thread');
    expect(JSON.stringify(message.blocks)).not.toContain('Your thread');
  });
});
