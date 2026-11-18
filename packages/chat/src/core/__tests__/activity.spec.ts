import { activityParentMessageIds } from '../activity';

const user = { messageId: 'u1', parentMessageId: 'root', isCreatedByUser: true };
const reply = { messageId: 'a1', parentMessageId: 'u1', isCreatedByUser: false };

describe('activityParentMessageIds', () => {
  it('anchors activity on a user row only until it has a reply', () => {
    expect(activityParentMessageIds(user, false, null)).toEqual(['u1']);
    expect(activityParentMessageIds(user, true, null)).toEqual([]);
  });

  it('anchors a reply on itself and its request', () => {
    expect(activityParentMessageIds(reply, false, null)).toEqual(['a1', 'u1']);
    expect(activityParentMessageIds(reply, true, -1)).toEqual(['a1', 'u1']);
  });

  it('drops an empty or missing parent id', () => {
    expect(activityParentMessageIds({ ...reply, parentMessageId: '' }, false, null)).toEqual([
      'a1',
    ]);
    expect(activityParentMessageIds({ ...reply, parentMessageId: null }, false, null)).toEqual([
      'a1',
    ]);
  });

  it('shows no activity while one of its anchors is being edited', () => {
    expect(activityParentMessageIds(reply, false, 'a1')).toEqual([]);
    expect(activityParentMessageIds(reply, false, 'u1')).toEqual([]);
    expect(activityParentMessageIds(user, false, 'u1')).toEqual([]);
    expect(activityParentMessageIds(reply, false, 'other')).toEqual(['a1', 'u1']);
  });
});
