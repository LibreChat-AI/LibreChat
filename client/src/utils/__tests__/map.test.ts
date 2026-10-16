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
    const map = mapAttachments([
      att({ file_id: 'f1' }),
      att({ toolCallId: 'call_1', file_id: 'f2' }),
      att({ toolCallId: '', file_id: 'f3' }),
    ]);
    expect(Object.keys(map).sort()).toEqual(['call_0', 'call_1']);
  });

  it('keeps a repeated file_id only under its later toolCallId', () => {
    const first = att({ toolCallId: 'call_0', file_id: 'f1' });
    const second = att({ toolCallId: 'call_1', file_id: 'f1' });
    const map = mapAttachments([first, second]);
    expect(map['call_0']).toBeUndefined();
    expect(map['call_1']).toEqual([second]);
  });

  it('drops an earlier duplicate of the same file within one toolCallId', () => {
    const first = att({ toolCallId: 'call_0', file_id: 'f1' });
    const second = att({ toolCallId: 'call_0', file_id: 'f1' });
    const map = mapAttachments([first, second]);
    expect(map['call_0']).toEqual([second]);
  });

  it('keeps two attachments with the same filename but different file_ids', () => {
    const first = att({ toolCallId: 'call_0', file_id: 'f1', filename: 'data.zip' });
    const second = att({ toolCallId: 'call_0', file_id: 'f2', filename: 'data.zip' });
    const map = mapAttachments([first, second]);
    expect(map['call_0']).toEqual([first, second]);
  });

  it('keeps every non-file attachment even when they share a toolCallId', () => {
    const first = att({ toolCallId: 'call_0', file_id: undefined });
    const second = att({ toolCallId: 'call_0', file_id: undefined });
    const map = mapAttachments([first, second]);
    expect(map['call_0']).toEqual([first, second]);
  });

  it('skips null and undefined entries', () => {
    const map = mapAttachments([null, att({ toolCallId: 'call_0' }), undefined]);
    expect(map['call_0']).toHaveLength(1);
  });

  it('keeps the newer write when copies are already in chronological order', () => {
    const older = att({ toolCallId: 'call_0', file_id: 'f1', updatedAt: '2024-01-01T00:00:00Z' });
    const newer = att({ toolCallId: 'call_1', file_id: 'f1', updatedAt: '2024-01-02T00:00:00Z' });
    const map = mapAttachments([older, newer]);
    expect(map['call_0']).toBeUndefined();
    expect(map['call_1']).toEqual([newer]);
  });

  it('keeps the newer write when an older duplicate sits at a higher array index', () => {
    const newer = att({ toolCallId: 'call_1', file_id: 'f1', updatedAt: '2024-01-02T00:00:00Z' });
    const older = att({ toolCallId: 'call_0', file_id: 'f1', updatedAt: '2024-01-01T00:00:00Z' });
    const map = mapAttachments([newer, older]);
    expect(map['call_0']).toBeUndefined();
    expect(map['call_1']).toEqual([newer]);
  });

  it('breaks a tie in write time by keeping the higher array index', () => {
    const first = att({ toolCallId: 'call_0', file_id: 'f1', updatedAt: '2024-01-01T00:00:00Z' });
    const second = att({ toolCallId: 'call_1', file_id: 'f1', updatedAt: '2024-01-01T00:00:00Z' });
    const map = mapAttachments([first, second]);
    expect(map['call_0']).toBeUndefined();
    expect(map['call_1']).toEqual([second]);
  });

  it('keeps the linked copy when an unlinked duplicate of the same file follows it', () => {
    const linked = att({ toolCallId: 'call_0', file_id: 'f1' });
    const unlinked = att({ toolCallId: '', file_id: 'f1' });
    const map = mapAttachments([linked, unlinked]);
    expect(map['call_0']).toEqual([linked]);
  });

  it('keeps two id-less attachments with the same filename but different filepaths', () => {
    const first = att({
      toolCallId: 'call_0',
      file_id: undefined,
      filename: 'data.zip',
      filepath: '/uploads/session-a/data.zip',
    });
    const second = att({
      toolCallId: 'call_1',
      file_id: undefined,
      filename: 'data.zip',
      filepath: '/uploads/session-b/data.zip',
    });
    const map = mapAttachments([first, second]);
    expect(map['call_0']).toEqual([first]);
    expect(map['call_1']).toEqual([second]);
  });

  it('drops an earlier id-less duplicate at the same filepath', () => {
    const first = att({
      toolCallId: 'call_0',
      file_id: undefined,
      filepath: '/uploads/session-a/data.zip',
    });
    const second = att({
      toolCallId: 'call_1',
      file_id: undefined,
      filepath: '/uploads/session-a/data.zip',
    });
    const map = mapAttachments([first, second]);
    expect(map['call_0']).toBeUndefined();
    expect(map['call_1']).toEqual([second]);
  });
});
