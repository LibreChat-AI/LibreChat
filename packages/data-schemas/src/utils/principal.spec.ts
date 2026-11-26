import { Types } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import { principalClauses } from './principal';

describe('principalClauses', () => {
  const userId = new Types.ObjectId();
  const groupIds = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];

  it('folds each type into one clause and matches the public principal by type alone', () => {
    expect(
      principalClauses([
        { principalType: PrincipalType.USER, principalId: userId },
        { principalType: PrincipalType.ROLE, principalId: 'USER' },
        ...groupIds.map((principalId) => ({ principalType: PrincipalType.GROUP, principalId })),
        { principalType: PrincipalType.PUBLIC },
      ]),
    ).toEqual([
      { principalType: PrincipalType.USER, principalId: userId },
      { principalType: PrincipalType.ROLE, principalId: 'USER' },
      { principalType: PrincipalType.GROUP, principalId: { $in: groupIds } },
      { principalType: PrincipalType.PUBLIC },
    ]);
  });

  it('keeps the clause count at one per type however many groups the user is in', () => {
    const many = Array.from({ length: 1000 }, () => new Types.ObjectId());
    const clauses = principalClauses([
      { principalType: PrincipalType.USER, principalId: userId },
      ...many.map((principalId) => ({ principalType: PrincipalType.GROUP, principalId })),
    ]);

    expect(clauses).toHaveLength(2);
    expect(clauses[1]).toEqual({ principalType: PrincipalType.GROUP, principalId: { $in: many } });
  });

  it('keeps ids of the same value apart when their types differ', () => {
    expect(
      principalClauses([
        { principalType: PrincipalType.GROUP, principalId: userId },
        { principalType: PrincipalType.USER, principalId: userId },
        { principalType: PrincipalType.GROUP, principalId: groupIds[0] },
      ]),
    ).toEqual([
      { principalType: PrincipalType.GROUP, principalId: { $in: [userId, groupIds[0]] } },
      { principalType: PrincipalType.USER, principalId: userId },
    ]);
  });

  it('sends a single public clause however often the public principal appears', () => {
    expect(
      principalClauses([
        { principalType: PrincipalType.PUBLIC },
        { principalType: PrincipalType.PUBLIC },
      ]),
    ).toEqual([{ principalType: PrincipalType.PUBLIC }]);
  });

  it('returns no clauses for no principals', () => {
    expect(principalClauses([])).toEqual([]);
  });
});
