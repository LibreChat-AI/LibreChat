import {
  getToolInputValidationDetails,
  parseToolInputValidationError,
  recordToolInputValidationError,
} from './toolValidation';

describe('getToolInputValidationDetails', () => {
  test('classifies an overlong ask_user_question option label without returning raw content', () => {
    const validationError = parseToolInputValidationError(
      new Error(
        'Received tool input did not match expected schema\n' +
          '✖ Option labels must be 280 characters or fewer. Shorten the label and retry.\n' +
          '  → at options[0].label',
      ),
    );
    const details = getToolInputValidationDetails(
      {
        tool_call: {
          name: 'ask_user_question',
        },
      },
      validationError,
    );

    expect(details).toEqual({
      toolName: 'ask_user_question',
      reason: 'option_label_too_long',
      fieldPath: 'options[0].label',
    });
    expect(JSON.stringify(details)).not.toContain('Shorten the label');
  });

  test('classifies an overlong option label nested in a question batch', () => {
    const validationError = parseToolInputValidationError(
      new Error(
        'Received tool input did not match expected schema\n' +
          '✖ String must contain at most 120 character(s)\n' +
          '  → at questions[0].options[0].label',
      ),
    );

    expect(
      getToolInputValidationDetails({ tool_call: { name: 'ask_user_question' } }, validationError),
    ).toEqual({
      toolName: 'ask_user_question',
      reason: 'option_label_too_long',
      fieldPath: 'questions[0].options[0].label',
    });
  });

  test('classifies other schema failures without requiring a field path', () => {
    expect(
      getToolInputValidationDetails(
        {
          tool_call: {
            name: 'search',
          },
        },
        parseToolInputValidationError(
          new Error('Received tool input did not match expected schema'),
        ),
      ),
    ).toEqual({ toolName: 'search', reason: 'invalid_tool_input' });
  });

  test('ignores matching successful tool output without an error signal', () => {
    expect(
      getToolInputValidationDetails(
        {
          tool_call: {
            name: 'ask_user_question',
            output: 'Received tool input did not match expected schema → at options[0].label',
          },
        },
        null,
      ),
    ).toBeNull();
  });

  test('records validation failures by tool call id only from thrown errors', () => {
    const errorsByToolCallId = new Map();

    recordToolInputValidationError(
      errorsByToolCallId,
      new Error('Received tool input did not match expected schema → at question'),
      'tool-1',
    );
    recordToolInputValidationError(errorsByToolCallId, 'successful user response', 'tool-2');

    expect(errorsByToolCallId).toEqual(
      new Map([['tool-1', { fieldPath: 'question', isLengthLimit: false }]]),
    );
  });
});
