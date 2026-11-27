import type { AgentOwnerContactSource } from './contact';
import { resolveAgentOwnerContact } from './contact';

describe('resolveAgentOwnerContact', () => {
  it('omits owner fallback when support contact has a name', () => {
    const result = resolveAgentOwnerContact(
      { support_contact: { name: 'Support Team' } },
      { name: 'Agent Owner' },
    );

    expect(result).toBeUndefined();
  });

  it('omits owner fallback when support contact has an email', () => {
    const result = resolveAgentOwnerContact(
      { support_contact: { email: 'support@example.com' } },
      { name: 'Agent Owner' },
    );

    expect(result).toBeUndefined();
  });

  it('uses owner name when support contact is empty', () => {
    const result = resolveAgentOwnerContact(
      { support_contact: { name: '  ', email: '' } },
      { name: ' Agent Owner ' },
    );

    expect(result).toEqual({ name: 'Agent Owner' });
  });

  it('never exposes an owner account email', () => {
    const result = resolveAgentOwnerContact({}, {
      name: 'Agent Owner',
      email: 'owner.private@example.com',
    } as AgentOwnerContactSource);

    expect(result).toEqual({ name: 'Agent Owner' });
    expect(result).not.toHaveProperty('email');
  });

  it('skips email-shaped owner names from auth-strategy fallbacks', () => {
    const result = resolveAgentOwnerContact(
      {},
      { name: 'owner.private@example.com', username: 'owner.user' },
    );

    expect(result).toEqual({ name: 'owner.user' });
  });

  it('omits owner contact when every display-name candidate is email-shaped', () => {
    const result = resolveAgentOwnerContact(
      { authorName: 'owner.private@example.com' },
      { name: 'owner.private@example.com', username: 'owner.private@example.com' },
    );

    expect(result).toBeUndefined();
  });

  it('skips emails with quoted local parts containing whitespace', () => {
    const result = resolveAgentOwnerContact(
      {},
      { name: '"given family"@example.com', username: 'owner.user' },
    );

    expect(result).toEqual({ name: 'owner.user' });
  });

  it('falls back to username for owner display name', () => {
    const result = resolveAgentOwnerContact({}, { username: 'owner.user' });

    expect(result).toEqual({ name: 'owner.user' });
  });

  it('falls back to authorName when owner has no display name', () => {
    const result = resolveAgentOwnerContact({ authorName: 'Legacy Author' }, { name: '' });

    expect(result).toEqual({ name: 'Legacy Author' });
  });

  it('omits owner contact when no owner can be resolved', () => {
    const result = resolveAgentOwnerContact({ authorName: 'Legacy Author' }, null);

    expect(result).toBeUndefined();
  });

  it('omits owner contact when no display name is available', () => {
    const result = resolveAgentOwnerContact({ authorName: ' ' }, {
      name: '',
      username: ' ',
      email: 'owner.private@example.com',
    } as AgentOwnerContactSource);

    expect(result).toBeUndefined();
  });
});
