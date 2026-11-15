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
});
