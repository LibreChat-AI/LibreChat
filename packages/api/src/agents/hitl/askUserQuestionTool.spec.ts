import {
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionToolDefinition,
  askUserQuestionToolSchema,
  createAskUserQuestionTool,
} from './askUserQuestionTool';

const question = (id = 'environment') => ({ id, question: 'Deploy where?' });

describe('ask_user_question tool contract', () => {
  test('the name matches the SDK interrupt discriminator the pipeline keys on', () => {
    expect(ASK_USER_QUESTION_TOOL_NAME).toBe('ask_user_question');
    expect(AskUserQuestionToolDefinition.name).toBe(ASK_USER_QUESTION_TOOL_NAME);
    expect(createAskUserQuestionTool().name).toBe(ASK_USER_QUESTION_TOOL_NAME);
  });

  describe('zod schema', () => {
    test('accepts one to four related questions', () => {
      const input = {
        questions: [
          {
            ...question(),
            header: 'Environment',
            description: 'Two environments are configured.',
            options: [
              { label: 'Staging', value: 'staging' },
              { label: 'Production', value: 'production' },
            ],
          },
          { ...question('window'), question: 'Which time window?', multiSelect: true },
        ],
      };
      expect(askUserQuestionToolSchema.parse(input)).toEqual(input);
    });

    test('rejects empty, oversized, duplicate-id, and unsafe-id batches', () => {
      expect(askUserQuestionToolSchema.safeParse({ questions: [] }).success).toBe(false);
      expect(
        askUserQuestionToolSchema.safeParse({
          questions: Array.from({ length: 5 }, (_, index) => question(`q${index}`)),
        }).success,
      ).toBe(false);
      expect(
        askUserQuestionToolSchema.safeParse({ questions: [question(), question()] }).success,
      ).toBe(false);
      expect(
        askUserQuestionToolSchema.safeParse({ questions: [question('time.window')] }).success,
      ).toBe(false);
    });

    test('rejects over-cap question and option content', () => {
      expect(
        askUserQuestionToolSchema.safeParse({
          questions: [{ ...question(), question: 'x'.repeat(2001) }],
        }).success,
      ).toBe(false);
      const options = Array.from({ length: 13 }, (_, index) => ({
        label: `opt ${index}`,
        value: `v${index}`,
      }));
      expect(
        askUserQuestionToolSchema.safeParse({
          questions: [{ ...question(), options }],
        }).success,
      ).toBe(false);
    });

    test('records an overlong option label against the real tool call', async () => {
      const validationErrors = new Map();
      await expect(
        createAskUserQuestionTool(validationErrors).invoke({
          id: 'tool-1',
          name: ASK_USER_QUESTION_TOOL_NAME,
          type: 'tool_call',
          args: {
            questions: [
              {
                ...question(),
                options: [{ label: 'x'.repeat(281), value: 'public-data' }],
              },
            ],
          },
        }),
      ).rejects.toThrow(
        'Option labels must be 280 characters or fewer. Shorten the label and retry.',
      );
      expect(validationErrors).toEqual(
        new Map([['tool-1', { fieldPath: 'questions[0].options[0].label', isLengthLimit: true }]]),
      );
    });

    test('accepts checkpointed legacy arguments without advertising them', async () => {
      const promise = createAskUserQuestionTool().invoke({
        id: 'legacy-call',
        name: ASK_USER_QUESTION_TOOL_NAME,
        type: 'tool_call',
        args: { question: 'Continue the pre-deploy run?' },
      });

      await expect(promise).rejects.toThrow('No configurable found in config');
      expect(AskUserQuestionToolDefinition.schema.required).toEqual(['questions']);
    });
  });

  describe('registry definition', () => {
    test('mirrors the nested batch schema and caps', () => {
      const questions = AskUserQuestionToolDefinition.schema.properties.questions;
      expect(AskUserQuestionToolDefinition.schema.required).toEqual(['questions']);
      expect(questions.minItems).toBe(1);
      expect(questions.maxItems).toBe(4);
      expect(questions.items.required).toEqual(['id', 'question']);
      expect(questions.items.properties.options.items.required).toEqual(['label', 'value']);
      expect(questions.items.properties.options.items.properties.label.maxLength).toBe(280);
    });

    test('describes one batched interaction and forbids sibling calls', () => {
      const instance = createAskUserQuestionTool();
      expect(instance.description).toBe(AskUserQuestionToolDefinition.description);
      expect(instance.description).toContain('one to four related');
      expect(instance.description).toContain('ONE tool call');
      expect(instance.description).toContain('NEVER call this tool in parallel');
    });
  });
});
