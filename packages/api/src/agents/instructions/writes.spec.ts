import { InstructionsPromptErrorCode } from 'librechat-data-provider';
import type { AgentInstructionsPrompt } from 'librechat-data-provider';
import {
  checkInstructionsPromptWrite,
  applyInstructionsPromptUnset,
  effectiveInstructionsPromptLink,
  excludeInstructionsWhenLinked,
  instructionsContentForScan,
} from './writes';
import { ContentTraversalLimitError } from '~/protection/adapters/nested';

const groupId = '507f1f77bcf86cd799439011';
const otherGroupId = '507f1f77bcf86cd799439022';

const user = { id: 'user-1', role: 'USER' };

const link: AgentInstructionsPrompt = {
  source: 'native',
  groupId,
  selection: { type: 'production' },
};

const otherLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId: otherGroupId,
  selection: { type: 'production' },
};

const restrictedStub = { source: 'native' as const, restricted: true as const };

/** No-op logger satisfying `InstructionsPromptAccessLogger`; tests that care about
 *  logging build their own and pass it instead. */
const logger = { warn: jest.fn(), error: jest.fn() };

describe('checkInstructionsPromptWrite', () => {
  it('returns null without calling access when the field is absent', async () => {
    const validateLinkWrite = jest.fn();
    const result = await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'update',
      user,
      previous: link,
      next: undefined,
      logger,
    });
    expect(result).toBeNull();
    expect(validateLinkWrite).not.toHaveBeenCalled();
  });

  it('validates the link on create', async () => {
    const validateLinkWrite = jest.fn(async () => ({ ok: true as const }));
    await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'create',
      user,
      previous: undefined,
      next: link,
      logger,
    });
    expect(validateLinkWrite).toHaveBeenCalledWith(
      expect.objectContaining({ previous: null, next: link }),
    );
  });

  it('validates the link on update', async () => {
    const validateLinkWrite = jest.fn(async () => ({ ok: true as const }));
    await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'update',
      user,
      previous: otherLink,
      next: link,
      logger,
    });
    expect(validateLinkWrite).toHaveBeenCalledWith(
      expect.objectContaining({ previous: otherLink, next: link }),
    );
  });

  it('maps a rejection to the HTTP-shaped error response', async () => {
    const validateLinkWrite = jest.fn(async () => ({
      ok: false as const,
      status: 403 as const,
      code: InstructionsPromptErrorCode.FORBIDDEN,
    }));
    const result = await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'create',
      user,
      previous: undefined,
      next: link,
      logger,
    });
    expect(result).toEqual({
      status: 403,
      body: { error: expect.any(String), code: InstructionsPromptErrorCode.FORBIDDEN },
    });
  });

  it('forwards filters', async () => {
    const validateLinkWrite = jest.fn(async () => ({ ok: true as const }));
    const filters = { pii: {} } as never;
    await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'create',
      user,
      previous: undefined,
      next: link,
      filters,
      logger,
    });
    expect(validateLinkWrite).toHaveBeenCalledWith(expect.objectContaining({ filters }));
  });

  it('forwards req to validateLinkWrite for create/update so its role lookup can share the caller cache', async () => {
    const validateLinkWrite = jest.fn(async () => ({ ok: true as const }));
    const req = { marker: 'request-handle' };
    await checkInstructionsPromptWrite({
      access: { validateLinkWrite },
      operation: 'update',
      user,
      previous: otherLink,
      next: link,
      logger,
      req,
    });
    expect(validateLinkWrite).toHaveBeenCalledWith(expect.objectContaining({ req }));
  });

  describe('an unexpected check failure', () => {
    it.each(['create', 'update'] as const)(
      'returns the fixed 500 and logs safely when validateLinkWrite throws on %s',
      async (operation) => {
        const log = { warn: jest.fn(), error: jest.fn() };
        const access = {
          validateLinkWrite: jest.fn(async () => {
            throw new Error('acl outage: secret-detail');
          }),
        };
        const result = await checkInstructionsPromptWrite({
          access,
          operation,
          user,
          previous: otherLink,
          next: link,
          logger: log,
        });
        expect(result).toEqual({
          status: 500,
          body: {
            error: 'Unable to validate the linked prompt',
            code: InstructionsPromptErrorCode.VALIDATION_FAILED,
          },
        });
        expect(log.error).toHaveBeenCalledTimes(1);
        const [, metadata] = log.error.mock.calls[0];
        expect(JSON.stringify(metadata)).not.toContain('secret-detail');
      },
    );

    it('rethrows a recognized content-filter error instead of masking it as a 500', async () => {
      const access = {
        validateLinkWrite: jest.fn(async () => {
          throw new ContentTraversalLimitError();
        }),
      };
      await expect(
        checkInstructionsPromptWrite({
          access,
          operation: 'create',
          user,
          previous: undefined,
          next: link,
          logger,
        }),
      ).rejects.toBeInstanceOf(ContentTraversalLimitError);
    });
  });
});

describe('applyInstructionsPromptUnset', () => {
  it('leaves the update untouched when the field is a link', () => {
    const updateData = { name: 'Agent', instructionsPrompt: link };
    expect(applyInstructionsPromptUnset(updateData)).toBe(updateData);
  });

  it('leaves the update untouched when the field is absent', () => {
    const updateData = { name: 'Agent' };
    expect(applyInstructionsPromptUnset(updateData)).toBe(updateData);
  });

  it('converts an explicit null into $unset and drops the field', () => {
    const updateData = { name: 'Agent', instructionsPrompt: null as null };
    const result = applyInstructionsPromptUnset(updateData);
    expect(result).toEqual({ name: 'Agent', $unset: { instructionsPrompt: 1 } });
    expect(result).not.toHaveProperty('instructionsPrompt');
  });

  it('merges with an existing $unset rather than replacing it', () => {
    const updateData = {
      name: 'Agent',
      instructionsPrompt: null as null,
      $unset: { git_identity: 1 },
    };
    const result = applyInstructionsPromptUnset(updateData);
    expect(result).toEqual({
      name: 'Agent',
      $unset: { git_identity: 1, instructionsPrompt: 1 },
    });
  });
});

describe('effectiveInstructionsPromptLink', () => {
  it('uses next when the payload carries the field', () => {
    expect(effectiveInstructionsPromptLink(link, otherLink)).toBe(link);
  });

  it('uses next when it is an explicit removal, even with a stored previous', () => {
    expect(effectiveInstructionsPromptLink(null, otherLink)).toBeNull();
  });

  it('falls back to previous when the field is absent from the payload', () => {
    expect(effectiveInstructionsPromptLink(undefined, otherLink)).toBe(otherLink);
  });

  it('is undefined when neither is set (create with no stored link)', () => {
    expect(effectiveInstructionsPromptLink(undefined, undefined)).toBeUndefined();
  });
});

describe('excludeInstructionsWhenLinked', () => {
  it('excludes instructions when the effective link is a real link', () => {
    const data = { instructions: 'blocked text', name: 'Agent' };
    const result = excludeInstructionsWhenLinked(data, { previous: undefined, effective: link });
    expect(result).toEqual({ instructions: undefined, name: 'Agent' });
  });

  it('leaves instructions untouched when there is no effective link', () => {
    const data = { instructions: 'inline text', name: 'Agent' };
    expect(excludeInstructionsWhenLinked(data, { previous: undefined, effective: null })).toBe(
      data,
    );
    expect(excludeInstructionsWhenLinked(data, { previous: undefined, effective: undefined })).toBe(
      data,
    );
  });

  it('leaves instructions untouched for a restricted stub (never valid on its own)', () => {
    const data = { instructions: 'inline text' };
    expect(
      excludeInstructionsWhenLinked(data, { previous: undefined, effective: restrictedStub }),
    ).toBe(data);
  });

  it('falls back to the stored instructions when the payload sends none and a previously valid link was removed', () => {
    const data = { instructions: undefined, name: 'Agent' };
    const result = excludeInstructionsWhenLinked(data, {
      previous: link,
      effective: null,
      fallbackInstructions: 'stored inline text',
    });
    expect(result).toEqual({ instructions: 'stored inline text', name: 'Agent' });
  });

  it('does NOT fall back for an ordinary unlinked agent (no previous link to remove) — regression guard', () => {
    // An unrelated partial edit of an agent that was never linked must scan only
    // what the payload sends, never stored text the write doesn't touch — even
    // when a fallback is supplied, as the update handler always does.
    const data = { instructions: undefined, name: 'Renamed' };
    const result = excludeInstructionsWhenLinked(data, {
      previous: null,
      effective: null,
      fallbackInstructions: 'stored text that would fail content policy',
    });
    expect(result).toBe(data);
  });

  it('does NOT fall back when previous was already the restricted stub (never a real link)', () => {
    const data = { instructions: undefined, name: 'Agent' };
    const result = excludeInstructionsWhenLinked(data, {
      previous: restrictedStub,
      effective: null,
      fallbackInstructions: 'stored inline text',
    });
    expect(result).toBe(data);
  });

  it('prefers the payload instructions over the fallback when both are present', () => {
    const data = { instructions: 'new inline text', name: 'Agent' };
    const result = excludeInstructionsWhenLinked(data, {
      previous: link,
      effective: null,
      fallbackInstructions: 'stored inline text',
    });
    expect(result).toBe(data);
  });

  it('leaves instructions untouched when there is no fallback and none in the payload', () => {
    const data = { instructions: undefined, name: 'Agent' };
    expect(excludeInstructionsWhenLinked(data, { previous: link, effective: null })).toBe(data);
    expect(excludeInstructionsWhenLinked(data, { previous: null, effective: undefined })).toBe(
      data,
    );
  });

  it('never falls back when the effective link is a real link (linked -> linked)', () => {
    const data = { instructions: undefined, name: 'Agent' };
    const result = excludeInstructionsWhenLinked(data, {
      previous: otherLink,
      effective: link,
      fallbackInstructions: 'stored inline text',
    });
    expect(result).toEqual({ instructions: undefined, name: 'Agent' });
  });
});

describe('instructionsContentForScan', () => {
  describe('create', () => {
    it('excludes instructions when the payload links on create', () => {
      const data = { instructions: 'blocked text', instructionsPrompt: link, name: 'Agent' };
      const result = instructionsContentForScan('create', { data });
      expect(result).toEqual({ instructions: undefined, instructionsPrompt: link, name: 'Agent' });
    });

    it('leaves instructions untouched when the payload has no link', () => {
      const data = { instructions: 'inline text', name: 'Agent' };
      expect(instructionsContentForScan('create', { data })).toBe(data);
    });
  });

  describe('duplicate', () => {
    it('excludes instructions when the source agent is linked', () => {
      const data = { instructions: 'blocked text', instructionsPrompt: link, name: 'Agent copy' };
      const result = instructionsContentForScan('duplicate', { data });
      expect(result).toEqual({
        instructions: undefined,
        instructionsPrompt: link,
        name: 'Agent copy',
      });
    });

    it('leaves instructions untouched when the source agent is unlinked', () => {
      const data = { instructions: 'inline text', name: 'Agent copy' };
      expect(instructionsContentForScan('duplicate', { data })).toBe(data);
    });
  });

  describe('update', () => {
    it('none -> valid: excludes instructions once the update links the agent', () => {
      const data = { instructions: 'blocked text', name: 'Agent' };
      const existing = { instructionsPrompt: null, instructions: 'stored text' };
      const result = instructionsContentForScan('update', { data, existing, nextLink: link });
      expect(result).toEqual({ instructions: undefined, name: 'Agent' });
    });

    it('valid -> null with no payload instructions: falls back to the stored instructions', () => {
      const data = { instructions: undefined, name: 'Agent' };
      const existing = { instructionsPrompt: link, instructions: 'stored inline text' };
      const result = instructionsContentForScan('update', { data, existing, nextLink: null });
      expect(result).toEqual({ name: 'Agent', instructions: 'stored inline text' });
    });

    it('valid -> valid: excludes instructions and ignores any fallback', () => {
      const data = { instructions: undefined, name: 'Agent' };
      const existing = { instructionsPrompt: link, instructions: 'stored inline text' };
      const result = instructionsContentForScan('update', { data, existing, nextLink: otherLink });
      expect(result).toEqual({ name: 'Agent', instructions: undefined });
    });

    it('unrelated partial edit on an unlinked agent has no fallback', () => {
      const data = { instructions: undefined, name: 'Renamed' };
      const existing = { instructionsPrompt: null, instructions: 'stored text that would fail' };
      const result = instructionsContentForScan('update', { data, existing, nextLink: undefined });
      expect(result).toBe(data);
    });
  });

  describe('revert', () => {
    it('none -> valid: excludes instructions once the snapshot carries a link', () => {
      const data = { instructions: 'blocked text', instructionsPrompt: link, name: 'Agent' };
      const existing = { instructionsPrompt: null, instructions: 'stored text' };
      const result = instructionsContentForScan('revert', { data, existing });
      expect(result).toEqual({ instructions: undefined, instructionsPrompt: link, name: 'Agent' });
    });

    it('valid -> null with no payload instructions: falls back to the current stored instructions', () => {
      const data = { instructions: undefined, instructionsPrompt: null, name: 'Agent' };
      const existing = { instructionsPrompt: link, instructions: 'stored inline text' };
      const result = instructionsContentForScan('revert', { data, existing });
      expect(result).toEqual({
        instructions: 'stored inline text',
        instructionsPrompt: null,
        name: 'Agent',
      });
    });

    it('valid -> valid: excludes instructions and ignores any fallback', () => {
      const data = { instructions: undefined, instructionsPrompt: otherLink, name: 'Agent' };
      const existing = { instructionsPrompt: link, instructions: 'stored inline text' };
      const result = instructionsContentForScan('revert', { data, existing });
      expect(result).toEqual({
        instructions: undefined,
        instructionsPrompt: otherLink,
        name: 'Agent',
      });
    });

    it('unrelated partial edit on an unlinked agent has no fallback', () => {
      const data = { instructions: undefined, instructionsPrompt: null, name: 'Renamed' };
      const existing = { instructionsPrompt: null, instructions: 'stored text that would fail' };
      const result = instructionsContentForScan('revert', { data, existing });
      expect(result).toBe(data);
    });
  });
});
