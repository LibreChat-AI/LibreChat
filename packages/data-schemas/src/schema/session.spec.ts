import sessionSchema from './session';

describe('sessionSchema', () => {
  it('prevents duplicate durable refresh-token sessions', () => {
    expect(sessionSchema.indexes()).toContainEqual([
      { user: 1, refreshTokenHash: 1 },
      { unique: true, background: true },
    ]);
  });
});
