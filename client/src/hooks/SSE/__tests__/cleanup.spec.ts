import { Constants } from 'librechat-data-provider';
import { shouldResetSubagentAtomsOnConversationChange } from '../cleanup';

describe('subagent atom cleanup', () => {
  it('preserves live subagent atoms when the active new chat receives its saved id', () => {
    expect(
      shouldResetSubagentAtomsOnConversationChange(
        Constants.NEW_CONVO,
        'conversation-1',
        'conversation-1',
      ),
    ).toBe(false);
  });

  it('resets live subagent atoms when leaving new chat for an existing conversation', () => {
    expect(
      shouldResetSubagentAtomsOnConversationChange(Constants.NEW_CONVO, 'conversation-1', null),
    ).toBe(true);
    expect(
      shouldResetSubagentAtomsOnConversationChange(
        Constants.NEW_CONVO,
        'conversation-1',
        'conversation-2',
      ),
    ).toBe(true);
  });

  it('resets live subagent atoms when leaving an established conversation', () => {
    expect(
      shouldResetSubagentAtomsOnConversationChange('conversation-1', 'conversation-2', null),
    ).toBe(true);
    expect(shouldResetSubagentAtomsOnConversationChange('conversation-1', null, null)).toBe(true);
    expect(shouldResetSubagentAtomsOnConversationChange('conversation-1', undefined, null)).toBe(
      true,
    );
  });

  it('does not reset on initial mount or same-conversation rerenders', () => {
    expect(shouldResetSubagentAtomsOnConversationChange(null, 'conversation-1', null)).toBe(false);
    expect(shouldResetSubagentAtomsOnConversationChange(undefined, 'conversation-1', null)).toBe(
      false,
    );
    expect(
      shouldResetSubagentAtomsOnConversationChange('conversation-1', 'conversation-1', null),
    ).toBe(false);
  });
});
