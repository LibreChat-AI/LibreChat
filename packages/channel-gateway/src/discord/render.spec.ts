import { discordRendererVersion, renderDiscordPlan, sanitizeDiscordMentions } from './render';

describe('Discord answer rendering', () => {
  test('splits Unicode without breaking surrogate pairs and preserves all text', () => {
    const source = '😀'.repeat(1500);
    const plan = renderDiscordPlan({ runId: 'run', text: source }, 3);
    expect(plan.rendererVersion).toBe(discordRendererVersion);
    expect(plan.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(renderDiscordPlan({ runId: 'run', text: source }, 3)).toEqual(plan);
    expect(plan.parts).toHaveLength(2);
    expect(plan.parts.map((part) => part.text).join('')).toBe(source);
    expect(
      plan.parts.every((part) => part.text.length <= 2000 && !/[\uD800-\uDBFF]$/.test(part.text)),
    ).toBe(true);
    expect(plan.parts.map((part) => part.operationId)).toEqual(['run:discord:0', 'run:discord:1']);
  });
  test.each(['', 'typescript'])('closes and reopens %s fenced code across chunks', (language) => {
    const plan = renderDiscordPlan(
      { runId: 'run', text: `\`\`\`${language}\n${'x'.repeat(4500)}\n\`\`\`` },
      4,
    );
    expect(plan.parts).toHaveLength(3);
    expect(
      plan.parts.every(
        (part) =>
          part.text.length <= 2000 &&
          part.text.startsWith(`\`\`\`${language}\n`) &&
          part.text.endsWith('```'),
      ),
    ).toBe(true);
  });
  test('sanitizes broadcast, user, role and channel mention syntax', () => {
    expect(sanitizeDiscordMentions('@everyone @here <@123> <@!123> <@&123> <#123>')).toBe(
      '@\u200beveryone @\u200bhere <@\u200b123> <@!\u200b123> <@&\u200b123> <#\u200b123>',
    );
  });
  test.each([1990, 1992])(
    'keeps a complete fenced block in one message with %i body characters',
    (length) => {
      const source = '```\n' + 'x'.repeat(length) + '\n```';
      const plan = renderDiscordPlan({ runId: 'run', text: source }, 1);
      expect(plan.parts.map((part) => part.text)).toEqual([source]);
    },
  );
  test('fails closed when the delivery budget cannot fit the answer', () => {
    expect(() => renderDiscordPlan({ runId: 'run', text: 'x'.repeat(2001) }, 1)).toThrow(
      'delivery budget',
    );
    expect(() =>
      renderDiscordPlan({ runId: 'run', text: '```\n' + 'x'.repeat(1990) }, 1),
    ).not.toThrow();
    expect(() => renderDiscordPlan({ runId: 'run', text: '```\n' + 'x'.repeat(1995) }, 1)).toThrow(
      'delivery budget',
    );
    expect(() => renderDiscordPlan({ runId: 'run', text: '' }, 1)).toThrow();
  });
  describe('shortening under a reduced budget', () => {
    const notice = 'Reply shortened to fit this channel’s delivery limit.';
    const fences = (text: string) =>
      text.split('\n').filter((line) => line.startsWith('```')).length;
    test.each([1, 2, 3])('keeps notice, closed fence and 2000 units with %i parts', (maxParts) => {
      const source = '```ts\n' + `${'y'.repeat(99)}\n`.repeat(200) + '```';
      const plan = renderDiscordPlan({ runId: 'run', text: source }, maxParts, { shorten: true });
      expect(plan.parts).toHaveLength(maxParts);
      for (const part of plan.parts) {
        expect(part.text.length).toBeLessThanOrEqual(2000);
        expect(fences(part.text) % 2).toBe(0);
      }
      const last = plan.parts[maxParts - 1].text;
      expect(last).toContain(notice);
      expect(last.indexOf('\n```\n\nReply shortened')).toBeGreaterThan(0);
      expect(plan.parts.slice(0, -1).some((part) => part.text.includes(notice))).toBe(false);
    });
    test('does not shorten an answer that fits, and still throws without the option', () => {
      const fits = '```\n' + 'x'.repeat(1990) + '\n```';
      const plan = renderDiscordPlan({ runId: 'run', text: fits }, 1, { shorten: true });
      expect(plan.parts.map((part) => part.text)).toEqual([fits]);
      const over = '```\n' + 'x'.repeat(5000) + '\n```';
      expect(() => renderDiscordPlan({ runId: 'run', text: over }, 1)).toThrow('delivery budget');
    });
    test('reserves notice room when a closing fence line would fit only without it', () => {
      const body = 'z'.repeat(2000 - 4 - 3 - 1);
      const source = '```\n' + body + '\n```\n' + 'tail '.repeat(100);
      const plan = renderDiscordPlan({ runId: 'run', text: source }, 1, { shorten: true });
      expect(plan.parts).toHaveLength(1);
      expect(plan.parts[0].text.length).toBeLessThanOrEqual(2000);
      expect(plan.parts[0].text).toContain(notice);
      expect(fences(plan.parts[0].text) % 2).toBe(0);
    });
  });
});
