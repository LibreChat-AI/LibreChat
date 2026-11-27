import type { TAttachment } from 'librechat-data-provider';
import { filterAttachmentsForPart, mapAttachments } from '../map';

const att = (overrides: Record<string, unknown>): TAttachment =>
  ({ toolCallId: 'call_0', file_id: 'f1', ...overrides }) as unknown as TAttachment;

describe('filterAttachmentsForPart', () => {
  it('drops attachments owned by a different agent (repeated provider ids)', () => {
    const attachments = [att({ agentId: 'agent_a' }), att({ agentId: 'agent_b', file_id: 'f2' })];
    const filtered = filterAttachmentsForPart(attachments, 'agent_b');
    expect(filtered).toHaveLength(1);
    expect((filtered?.[0] as { file_id?: string }).file_id).toBe('f2');
  });

  it('treats missing agentId on either side as a wildcard', () => {
    const attachments = [att({}), att({ agentId: 'agent_a', file_id: 'f2' })];
    expect(filterAttachmentsForPart(attachments, 'agent_a')).toHaveLength(2);
    expect(filterAttachmentsForPart(attachments, undefined)).toHaveLength(2);
  });

  it('routes repeated same-agent provider ids by host run-step identity', () => {
    const attachments = [
      att({ agentId: 'agent_a', stepId: 'step-1' }),
      att({ agentId: 'agent_a', stepId: 'step-2', file_id: 'f2' }),
      att({ agentId: 'agent_a', file_id: 'legacy' }),
    ];
    const filtered = filterAttachmentsForPart(attachments, 'agent_a', 'step-2');
    expect(filtered?.map((attachment) => (attachment as { file_id?: string }).file_id)).toEqual([
      'f2',
      'legacy',
    ]);
  });

  it('still scopes by step when a legacy part has no agent identity', () => {
    const attachments = [att({ stepId: 'step-1' }), att({ stepId: 'step-2', file_id: 'f2' })];
    expect(filterAttachmentsForPart(attachments, undefined, 'step-1')).toHaveLength(1);
  });

  it('keeps earlier owned steps off a live repeated call', () => {
    const attachments = [
      att({ agentId: 'agent_a', stepId: 'step-1' }),
      att({ agentId: 'agent_a', stepId: 'step-live', file_id: 'live' }),
      att({ agentId: 'agent_a', file_id: 'legacy' }),
    ];
    const filtered = filterAttachmentsForPart(
      attachments,
      'agent_a',
      undefined,
      new Set(['step-1']),
    );
    expect(filtered?.map((attachment) => (attachment as { file_id?: string }).file_id)).toEqual([
      'live',
      'legacy',
    ]);
  });

  it('returns the same reference when nothing is filtered (render stability)', () => {
    const attachments = [att({ agentId: 'agent_a' })];
    expect(filterAttachmentsForPart(attachments, 'agent_a')).toBe(attachments);
  });
});

describe('mapAttachments', () => {
  it('groups by toolCallId and drops unkeyed entries', () => {
    const map = mapAttachments([att({}), att({ toolCallId: 'call_1' }), att({ toolCallId: '' })]);
    expect(Object.keys(map).sort()).toEqual(['call_0', 'call_1']);
  });
});
