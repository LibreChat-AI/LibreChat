import userSchema from './user';

describe('userSchema', () => {
  describe('credentialsChangedAt', () => {
    it('is a Date path so a password reset can persist the access-token cutoff', () => {
      const path = userSchema.path('credentialsChangedAt');

      expect(path).toBeDefined();
      expect(path.instance).toBe('Date');
    });

    it('is writable through a strict-mode update', () => {
      const changedAt = new Date(1700000010500);
      const update = userSchema.path('credentialsChangedAt').cast(changedAt);

      expect(update).toEqual(changedAt);
    });
  });
});
