import {
  updatePromptGroupSchema,
  validatePromptGroupUpdate,
  safeValidatePromptPayload,
  safeValidatePromptGroupUpdate,
} from './schemas';

describe('safeValidatePromptPayload', () => {
  it('keeps the prompt fields and removes other fields', () => {
    const result = safeValidatePromptPayload({
      prompt: 'Text',
      type: 'chat',
      groupId: 'group-1',
      author: 'user-1',
    });

    expect(result.success && result.data).toEqual({ prompt: 'Text', type: 'chat' });
  });

  it.each([
    [null, 'Prompt text is required and must be a non-empty string'],
    [{ type: 'text' }, 'Prompt text is required and must be a non-empty string'],
    [{ prompt: 42, type: 'text' }, 'Prompt text is required and must be a non-empty string'],
    [{ prompt: '   ', type: 'text' }, 'Prompt text is required and must be a non-empty string'],
    [{ prompt: 'Text' }, 'Prompt type must be "text" or "chat"'],
    [{ prompt: 'Text', type: 'image' }, 'Prompt type must be "text" or "chat"'],
  ])('rejects %j with the route message', (payload, message) => {
    const result = safeValidatePromptPayload(payload);

    expect(result.success).toBe(false);
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(message);
  });
});

describe('updatePromptGroupSchema', () => {
  describe('allowed fields', () => {
    it('should accept valid name field', () => {
      const result = updatePromptGroupSchema.safeParse({ name: 'Test Group' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Test Group');
      }
    });

    it('should accept valid oneliner field', () => {
      const result = updatePromptGroupSchema.safeParse({ oneliner: 'A short description' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.oneliner).toBe('A short description');
      }
    });

    it('should accept valid category field', () => {
      const result = updatePromptGroupSchema.safeParse({ category: 'testing' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.category).toBe('testing');
      }
    });

    it('should accept valid command field', () => {
      const result = updatePromptGroupSchema.safeParse({ command: 'my-command-123' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.command).toBe('my-command-123');
      }
    });

    it('should accept null command field', () => {
      const result = updatePromptGroupSchema.safeParse({ command: null });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.command).toBeNull();
      }
    });

    it('should accept multiple valid fields', () => {
      const input = {
        name: 'Updated Name',
        category: 'new-category',
        oneliner: 'New description',
      };
      const result = updatePromptGroupSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(input);
      }
    });

    it('should accept empty object', () => {
      const result = updatePromptGroupSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe('security - strips sensitive fields', () => {
    it('should reject author field', () => {
      const result = updatePromptGroupSchema.safeParse({
        name: 'Test',
        author: '507f1f77bcf86cd799439011',
      });
      expect(result.success).toBe(false);
    });

    it('should reject authorName field', () => {
      const result = updatePromptGroupSchema.safeParse({
        name: 'Test',
        authorName: 'Malicious Author',
      });
      expect(result.success).toBe(false);
    });

    it('should reject _id field', () => {
      const result = updatePromptGroupSchema.safeParse({
        name: 'Test',
        _id: '507f1f77bcf86cd799439011',
      });
      expect(result.success).toBe(false);
    });

    it('should reject productionId field', () => {
      const result = updatePromptGroupSchema.safeParse({
        name: 'Test',
        productionId: '507f1f77bcf86cd799439011',
      });
      expect(result.success).toBe(false);
    });

    it('should reject createdAt field', () => {
      const result = updatePromptGroupSchema.safeParse({
        name: 'Test',
        createdAt: new Date().toISOString(),
      });
      expect(result.success).toBe(false);
    });

    it('should reject updatedAt field', () => {
      const result = updatePromptGroupSchema.safeParse({
        name: 'Test',
        updatedAt: new Date().toISOString(),
      });
      expect(result.success).toBe(false);
    });

    it('should reject __v field', () => {
      const result = updatePromptGroupSchema.safeParse({
        name: 'Test',
        __v: 999,
      });
      expect(result.success).toBe(false);
    });

    it('should reject multiple sensitive fields in a single request', () => {
      const result = updatePromptGroupSchema.safeParse({
        name: 'Legit Name',
        author: '507f1f77bcf86cd799439011',
        authorName: 'Hacker',
        _id: 'newid123',
        productionId: 'prodid456',
        createdAt: '2020-01-01T00:00:00.000Z',
        __v: 999,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('validation rules', () => {
    it('should reject empty name', () => {
      const result = updatePromptGroupSchema.safeParse({ name: '' });
      expect(result.success).toBe(false);
    });

    it('should reject name exceeding max length', () => {
      const result = updatePromptGroupSchema.safeParse({ name: 'a'.repeat(256) });
      expect(result.success).toBe(false);
    });

    it('should reject oneliner exceeding max length', () => {
      const result = updatePromptGroupSchema.safeParse({ oneliner: 'a'.repeat(501) });
      expect(result.success).toBe(false);
    });

    it('should reject category exceeding max length', () => {
      const result = updatePromptGroupSchema.safeParse({ category: 'a'.repeat(101) });
      expect(result.success).toBe(false);
    });

    it('should reject command with invalid characters (uppercase)', () => {
      const result = updatePromptGroupSchema.safeParse({ command: 'MyCommand' });
      expect(result.success).toBe(false);
    });

    it('should reject command with invalid characters (spaces)', () => {
      const result = updatePromptGroupSchema.safeParse({ command: 'my command' });
      expect(result.success).toBe(false);
    });

    it('should reject command with invalid characters (special)', () => {
      const result = updatePromptGroupSchema.safeParse({ command: 'my_command!' });
      expect(result.success).toBe(false);
    });
  });
});

describe('validatePromptGroupUpdate', () => {
  it('should return validated data for valid input', () => {
    const input = { name: 'Test', category: 'testing' };
    const result = validatePromptGroupUpdate(input);
    expect(result).toEqual(input);
  });

  it('should throw ZodError for invalid input', () => {
    expect(() => validatePromptGroupUpdate({ author: 'malicious-id' })).toThrow();
  });
});

describe('safeValidatePromptGroupUpdate', () => {
  it('should return success true for valid input', () => {
    const result = safeValidatePromptGroupUpdate({ name: 'Test' });
    expect(result.success).toBe(true);
  });

  it('should return success false for invalid input with errors', () => {
    const result = safeValidatePromptGroupUpdate({ author: 'malicious-id' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.length).toBeGreaterThan(0);
    }
  });
});
