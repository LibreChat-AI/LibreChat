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
  it('honors configured budgets above 64 messages for ordinary answers', () => {
    const view = run();
    view.snapshot!.text = '# Heading\n\n'.repeat(2700);
    const plan = makeSlackPlan(view, false, 100);
    expect(plan.parts.length).toBeGreaterThan(64);
    expect(plan.parts.length).toBeLessThanOrEqual(100);
    expect(plan.parts.map((part) => part.text).join('')).not.toContain('Reply shortened');
    for (const part of plan.parts)
      expect(() => durableSlackMessage(part, plan.rendererVersion)).not.toThrow();
  });

  it('parses balanced and escaped link parentheses without touching literal code', () => {
    expect(safeMrkdwn('[docs](https://example.com/Foo_(bar))')).toBe(
      '<https://example.com/Foo_(bar)|docs>',
    );
    expect(safeMrkdwn('[docs](https://example.com/a_(b_(c)))')).toBe(
      '<https://example.com/a_(b_(c))|docs>',
    );
    expect(safeMrkdwn(String.raw`[docs](https://example.com/a\(b\))`)).toBe(
      '<https://example.com/a(b)|docs>',
    );
    expect(safeMrkdwn('`[docs](https://example.com/Foo_(bar))`')).toBe(
      '`[docs](https://example.com/Foo_(bar))`',
    );
    expect(safeMrkdwn('[unsafe](javascript:alert(1))')).toBe('unsafe');
    expect(safeMrkdwn('[unfinished](https://example.com/a_(b)')).toBe(
      '[unfinished](<https://example.com/a_(b)>',
    );
  });

  it.each([1, 2, 3, 100])('keeps required text and artifact groups within budget %i', (budget) => {
    const view = run();
    view.snapshot!.artifacts = [artifact];
    const plan = makeSlackPlan(view, false, budget);
    expect(plan.parts.length).toBeLessThanOrEqual(budget);
    expect(plan.parts[0].required).toBe(true);
    expect(plan.parts[0].text).toContain('Hello');
    if (plan.parts.some((part) => part.kind === 'artifact'))
      expect(plan.parts.some((part) => part.operationId.endsWith(':artifact-status'))).toBe(true);
    else expect(plan.parts[0].text).toContain('omitted');
  });

  it('reflows rich blocks and explicitly bounds oversized required output under a reduced budget', () => {
    const view = run();
    view.snapshot!.text = 'answer '.repeat(15000);
    const plan = makeSlackPlan(view, false, 1);
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0].text).toContain('Reply shortened');
    expect(Buffer.byteLength(plan.parts[0].text)).toBeLessThan(40000);
    expect(view.snapshot!.text.length).toBe(105000);
  });

  it.each([2795, 2799, 2800, 2801])(
    'keeps complete formatting tokens at the %i-byte boundary',
    (prefix) => {
      for (const token of [
        [
          '[docs](https://example.com/Foo_(bar)?x=1&y=2)',
          '<https://example.com/Foo_(bar)?x=1&amp;y=2|docs>',
        ],
        ['`code <@U1> **literal**`', '`code &lt;@U1&gt; **literal**`'],
        ['**bold words**', '*bold words*'],
        ['**bold\nwords**', '*bold\nwords*'],
        ['_italic words_', '_italic words_'],
        ['~strike words~', '~strike words~'],
        ['&', '&amp;'],
      ]) {
        const source = 'x'.repeat(prefix) + ' ' + token[0] + ' tail';
        const blocks = renderSlackDocument(source).flatMap((message) => message.blocks ?? []);
        const texts = blocks.flatMap((block) =>
          block.type === 'section' ? [block.text.text] : [],
        );
        expect(texts.some((text) => text.includes(token[1]))).toBe(true);
        expect(texts.every((text) => Buffer.byteLength(text) <= 2800)).toBe(true);
        expect(texts.join('')).toBe(safeMrkdwn(source));
      }
    },
  );

  it('preserves UTF8 and large atomic tokens with bounded explicit plain-text fallback', () => {
    const source = '🙂'.repeat(699) + '[docs](https://example.com/a_(b))';
    const texts = renderSlackDocument(source)
      .flatMap((message) => message.blocks ?? [])
      .flatMap((block) => (block.type === 'section' ? [block.text.text] : []));
    expect(texts.join('')).toBe(safeMrkdwn(source));
    expect(texts.every((text) => Buffer.byteLength(text) <= 2800)).toBe(true);
    for (const [large, plain] of [
      [
        '[docs](https://example.com/' + 'a'.repeat(3000) + ')',
        'docs (https://example.com/' + 'a'.repeat(3000) + ')',
      ],
      ['`' + 'x'.repeat(3000) + '`', 'x'.repeat(3000)],
      ['**' + 'x'.repeat(3000) + '**', 'x'.repeat(3000)],
    ]) {
      const blocks = renderSlackDocument(large).flatMap((message) => message.blocks ?? []);
      expect(
        blocks.every((block) => block.type === 'section' && block.text.type === 'plain_text'),
      ).toBe(true);
      expect(
        blocks.flatMap((block) => (block.type === 'section' ? [block.text.text] : [])).join(''),
      ).toBe(plain);
    }
  });

  it('uses GFM link grammar for nested labels, references and autolinks', () => {
    const url = 'https://example.com/__file__?q=**value**';
    expect(safeMrkdwn('[outer **bold** and `code`](' + url + ' "title")')).toBe(
      '<' + url + '|outer bold and code>',
    );
    const source = '[guide][DOC] and [doc]\n\n[doc]: ' + url + ' "title"';
    expect(safeMrkdwn(source)).toBe('<' + url + '|guide> and <' + url + '|doc>\n\n');
    expect(renderAgentAnswer(source)[0].blocks).toEqual([{ type: 'markdown', text: source }]);
    expect(renderSlackDocument(source)[0].text).toBe('<' + url + '|guide> and <' + url + '|doc>');
    // Bare autolinks exclude trailing Markdown punctuation under GFM.
    expect(safeMrkdwn(url + 'end')).toBe('<' + url + 'end>');
    expect(safeMrkdwn('<' + url + '>')).toBe('<' + url + '>');
    expect(safeMrkdwn('`[doc]`\n\n[doc]: ' + url)).toBe('`[doc]`\n\n');
  });

  it('sanitizes reference targets and oversized fallback without resurrecting credentials', () => {
    const source = '[label][secret]\n\n[secret]: https://user:password@example.com/private';
    for (const messages of [renderSlackDocument(source), renderAgentAnswer(source)]) {
      expect(JSON.stringify(messages)).not.toContain('password');
      expect(messages[0].text).toContain('label');
    }
    const large = '**' + 'x'.repeat(3000) + ' [private](https://user:password@example.com)**';
    const messages = renderSlackDocument(large);
    expect(JSON.stringify(messages)).not.toContain('password');
    expect(
      messages
        .flatMap((message) => message.blocks ?? [])
        .every((block) => block.type === 'section' && block.text.type === 'plain_text'),
    ).toBe(true);
    expect(messages.map((message) => message.plain).join('')).toContain('private');
  });

  it.each(['https://user:password@example.com', 'javascript:alert'])(
    'keeps synthetic GFM nodes inside the link sanitizer for %s',
    (target) => {
      const source = JSON.stringify({
        version: 1,
        blocks: [
          {
            type: 'card',
            body: `[private](${target})`,
            links: [{ url: 'https://docs.slack.dev/' }],
          },
        ],
      });
      expect(safeMrkdwn(source)).not.toContain(target);
      for (const messages of [renderSlackDocument(source), renderAgentAnswer(source)]) {
        const serialized = JSON.stringify(messages);
        expect(serialized).not.toContain(target);
        expect(serialized).toContain('private');
        expect(serialized).toContain('https://docs.slack.dev/');
        expect(
          messages.some((message) => message.blocks?.some((block) => block.type === 'markdown')),
        ).toBe(false);
      }
    },
  );

  it('bounds escaped semantic fallback and keeps safe link destinations readable', () => {
    const view = run();
    view.snapshot!.text = ('&'.repeat(3000) + ' [docs](https://example.com/__file__)\n\n').repeat(
      8,
    );
    const plan = makeSlackPlan(view, false, 1);
    expect(plan.parts).toHaveLength(1);
    const message = durableSlackMessage(plan.parts[0], rendererVersion);
    expect(Buffer.byteLength(message.text)).toBeLessThanOrEqual(39000);
    expect(message.text).toContain('Reply shortened');
    const plain = message.blocks
      ?.flatMap((block) => (block.type === 'section' ? [block.text.text] : []))
      .join('');
    expect(plain).toContain('docs (https://example.com/__file__)');
    expect(plain).not.toContain('<https://');
    expect(plan.parts[0]).not.toHaveProperty('plain');
  });

  it('fills every usable slot while preserving artifact/status grouping', () => {
    const view = run();
    view.snapshot!.artifacts = [artifact, { ...artifact, artifactId: 'bad', filename: '../bad' }];
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
      session: { url: 'https://chat.example.com/c/session' },
    };
    for (const budget of [1, 2, 3, 4, 5, 6]) {
      const plan = makeSlackPlan(view, false, budget);
      expect(plan.parts).toHaveLength(Math.min(budget, 5));
      expect(plan.parts[0].required).toBe(true);
      if (plan.parts.some((part) => part.kind === 'artifact'))
        expect(plan.parts.some((part) => part.operationId.endsWith(':artifact-status'))).toBe(true);
      for (const part of plan.parts)
        expect(() => durableSlackMessage(part, rendererVersion)).not.toThrow();
      expect(makeSlackPlan(view, false, budget)).toEqual(plan);
      if (budget >= 4) expect(plan.parts.some((part) => part.traceUrl)).toBe(true);
    }
  });

  it('reflows reduced-budget output as bounded plain text without splitting formatted block syntax', () => {
    const view = run();
    view.snapshot!.text =
      'x'.repeat(38990) + ' [docs](https://example.com/a_(b)) ' + 'tail '.repeat(500);
    const plan = makeSlackPlan(view, false, 1);
    expect(plan.parts).toHaveLength(1);
    const message = durableSlackMessage(plan.parts[0], rendererVersion);
    expect(
      message.blocks?.every(
        (block) => block.type === 'section' && block.text.type === 'plain_text',
      ),
    ).toBe(true);
    expect(message.text).toContain('Reply shortened');
    expect(Buffer.byteLength(message.text)).toBeLessThan(40000);
    expect(supportedRenderer('slack-structured-v5')).toBe(true);
    expect(() =>
      durableSlackMessage(
        {
          ...plan.parts[0],
          presentation: {
            format: presentationFormat,
            payload: JSON.stringify([
              { type: 'section', text: { type: 'mrkdwn', text: 'legacy' } },
            ]),
          },
        },
        'slack-structured-v5',
      ),
    ).not.toThrow();
  });

  it('preserves existing formatting when an omission notice fits and bounds every serialized fallback', () => {
    const view = run();
    view.snapshot!.artifacts = [artifact];
    const part = makeSlackPlan(view, false, 1).parts[0];
    const message = durableSlackMessage(part, rendererVersion);
    expect(
      message.blocks?.some(
        (block) =>
          block.type === 'section' &&
          block.text.type === 'mrkdwn' &&
          block.text.text.includes('*world*'),
      ),
    ).toBe(true);
    expect(
      message.blocks?.some(
        (block) =>
          block.type === 'section' &&
          block.text.type === 'plain_text' &&
          block.text.text.includes('omitted'),
      ),
    ).toBe(true);
    view.snapshot!.text = '\u0000'.repeat(15000);
    for (const generated of makeSlackPlan(view, false, 1).parts) {
      if (generated.presentation)
        expect(Buffer.byteLength(generated.presentation.payload)).toBeLessThanOrEqual(64000);
      expect(() => durableSlackMessage(generated, rendererVersion)).not.toThrow();
    }
  });

  it.each([
    '__file__',
    '**file**',
    'a__b__c?x=__query__&y=**query**',
    'a`b`c',
    'a_(b_(c))__name__',
    'a**file**?q=__x__',
  ])('never formats the destination %s after constructing a link', (path) => {
    const url = 'https://example.com/' + path;
    const source = '[docs](' + url + ')';
    const wire = '<' + url.replaceAll('&', '&amp;') + '|docs>';
    expect(safeMrkdwn(source)).toBe(wire);
    expect(renderAgentAnswer(source)[0].blocks).toEqual([{ type: 'markdown', text: source }]);
    const long = renderAgentAnswer('x'.repeat(12001) + ' ' + source);
    expect(
      long
        .flatMap((message) => message.blocks ?? [])
        .some((block) => block.type === 'section' && block.text.text.includes(wire)),
    ).toBe(true);
  });

  it('formats prose around immutable link/code atoms and keeps fence line boundaries', () => {
    const link = '[docs](https://example.com/__file__)';
    expect(safeMrkdwn('**Before ' + link + ' `__literal__` after**')).toBe(
      '*Before <https://example.com/__file__|docs> `__literal__` after*',
    );
    expect(safeMrkdwn('```txt\n__literal__\n```\n# ' + link)).toBe(
      '```txt\n__literal__\n```\n*<https://example.com/__file__|docs>*',
    );
    const forged = '\0' + 'a'.repeat(64) + ':0\0';
    expect(safeMrkdwn(forged + link)).toBe(
      forged.replaceAll('\0', '\ufffd') + '<https://example.com/__file__|docs>',
    );
    const unmatched = Array.from({ length: 256 }, (_, i) => 'x' + '`'.repeat(i + 1) + 'y').join('');
    expect(safeMrkdwn(unmatched)).toBe(unmatched);
  });

  it.each([2790, 2795, 2800, 2805])(
    'retains source atom boundaries through enclosing styles at offset %i',
    (offset) => {
      const source =
        '**Before [docs](https://example.com/__file__?q=**value**) `__literal__` after**';
      const expected =
        '*Before <https://example.com/__file__?q=**value**|docs> `__literal__` after*';
      const messages = renderSlackDocument('x'.repeat(offset) + source);
      const sections = messages
        .flatMap((message) => message.blocks ?? [])
        .flatMap((block) => (block.type === 'section' ? [block.text] : []));
      expect(
        sections.some((section) => section.type === 'mrkdwn' && section.text.includes(expected)),
      ).toBe(true);
      expect(sections.map((section) => section.text).join('')).toBe('x'.repeat(offset) + expected);
      const oversized = renderSlackDocument(
        '**' + 'x'.repeat(offset) + ' [docs](https://example.com/**path**) after**',
      );
      expect(
        oversized
          .flatMap((message) => message.blocks ?? [])
          .every((block) => block.type === 'section' && block.text.type === 'plain_text'),
      ).toBe(true);
    },
  );

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

  it('preserves v5 frozen content even when user text resembles an obsolete generated footer', () => {
    const frozen = {
      operationId: 'legacy',
      kind: 'message' as const,
      required: true,
      text: 'User content\n\n_This run · ID example_\n<https://example.com/user-authored|View session>',
    };
    expect(durableSlackMessage(frozen, 'slack-structured-v5').text).toBe(frozen.text);
    expect(
      durableSlackMessage(
        {
          ...frozen,
          presentation: {
            format: presentationFormat,
            payload: JSON.stringify([
              { type: 'section', text: { type: 'mrkdwn', text: frozen.text } },
            ]),
          },
        },
        'slack-structured-v5',
      ).text,
    ).toBe(frozen.text);
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
    '[{"type":"section","text":{"type":"html","text":"wrong"}}]',
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
    expect(JSON.stringify(context)).not.toContain('View session');
    const plan = makeSlackPlan(view);
    expect(plan.parts.filter((part) => part.traceUrl)).toEqual([
      expect.objectContaining({
        kind: 'message',
        required: false,
        traceUrl: 'https://chat.example.com/c/session',
      }),
    ]);
    expect(
      plan.parts
        .filter((part) => part.required)
        .map((part) => JSON.stringify(part))
        .join(),
    ).not.toContain('https://chat.example.com/c/session');
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

describe('presentation boundaries', () => {
  it.each([
    '`__init__ [docs](./README.md)`',
    '``a `tick` __init__ [docs](./README.md)``',
    '```md\n[docs](./README.md) __init__\n```',
    '~~~md\n[docs](./README.md) __init__\n~~~',
    '````md\n``` __init__ [docs](./README.md)\n````',
    '```md\n[docs](./README.md) __init__',
  ])('preserves literal code %s in native blocks and escaped fallback', (code) => {
    expect(safeMrkdwn(code)).toBe(code);
    expect(renderAgentAnswer(code)[0].blocks).toEqual([{ type: 'markdown', text: code }]);
    const document = renderSlackDocument(code);
    expect(JSON.stringify(document)).toContain('__init__');
    expect(JSON.stringify(document)).toContain('[docs](./README.md)');
  });
  it.each(['&'.repeat(12000), '🙂'.repeat(12000), '<'.repeat(12000)])(
    'bounds converted native fallback, including expanding text',
    (answer) => {
      const view = run();
      view.snapshot!.text = answer;
      for (const part of makeSlackPlan(view, true).parts) {
        expect(part.text.length).toBeLessThanOrEqual(40000);
        expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(39000);
        expect(() => durableSlackMessage(part, rendererVersion)).not.toThrow();
      }
    },
  );
});

test('legacy required footer recovery removes embedded trace capability while preserving answer and metrics', () => {
  const url = 'https://chat.example.com/c/session';
  const part = {
    operationId: 'old:reply:0',
    kind: 'message' as const,
    required: true,
    text: `Answer\n\n_This run · ID old_\n_This run: Cost unavailable_\n<${url}|View session>`,
    presentation: {
      format: presentationFormat,
      payload: JSON.stringify([
        { type: 'section', text: { type: 'mrkdwn', text: 'Answer' } },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `Cost unavailable · Run old · <${url}|View session>` },
          ],
        },
      ]),
    },
  };
  const snapshot = structuredClone(part);
  for (const version of ['slack-structured-v2', 'slack-structured-v3', 'slack-structured-v4']) {
    const message = durableSlackMessage(part, version);
    expect(JSON.stringify(message)).not.toContain(url);
    expect(message.text).toContain('Answer');
    expect(message.text).toContain('Cost unavailable');
  }
  expect(part).toEqual(snapshot);
});
