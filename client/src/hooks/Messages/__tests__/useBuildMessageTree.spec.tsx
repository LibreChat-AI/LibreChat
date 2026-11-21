import { renderHook } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import useBuildMessageTree from '../useBuildMessageTree';

const trigger = {
  event: { type: 'subagent.completion', occurredAt: '2026-11-20T10:00:00.000Z' },
  subject: { kind: 'schedule', id: 'schedule-1' },
};

const reply = { messageId: 'reply', parentMessageId: 'wake', text: 'Done.', children: [] };
const wake = {
  messageId: 'wake',
  parentMessageId: 'root',
  text: 'A task has settled.',
  isCreatedByUser: true,
  trigger,
  children: [reply],
} as unknown as TMessage;

describe('useBuildMessageTree', () => {
  it.each([
    { branches: false, recursive: false },
    { branches: true, recursive: false },
    { branches: false, recursive: true },
    { branches: true, recursive: true },
  ])('leaves what started a turn out of an export (%o)', async (options) => {
    const { result } = renderHook(() => useBuildMessageTree());

    const exported = await result.current({
      messageId: 'conversation',
      message: null,
      messages: [wake],
      ...options,
    });

    const file = JSON.stringify(exported);
    expect(file).toContain('A task has settled.');
    expect(file).toContain('Done.');
    expect(file).not.toContain('trigger');
    expect(file).not.toContain('schedule-1');
    expect(wake.trigger).toBe(trigger);
  });
});
