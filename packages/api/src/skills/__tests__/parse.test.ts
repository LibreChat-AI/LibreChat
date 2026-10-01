import { SKILL_BOOLEAN_FLAGS as SCHEMA_BOOLEAN_FLAGS } from '@librechat/data-schemas';
import { SKILL_BOOLEAN_FLAGS } from '../parse';

/**
 * The parser keeps its own copy of the flag table so it stays loadable when a
 * suite replaces `@librechat/data-schemas` with a partial mock. This test is
 * what keeps that copy honest: the parser decides which keys are read out of a
 * SKILL.md, data-schemas decides which columns they feed, and a mismatch would
 * silently drop a flag on one side only.
 */
describe('SKILL_BOOLEAN_FLAGS', () => {
  it('matches the table in data-schemas exactly', () => {
    expect(SKILL_BOOLEAN_FLAGS).toEqual(SCHEMA_BOOLEAN_FLAGS);
  });
});
