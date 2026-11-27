import { ZodError, z } from 'zod';
import {
  generateDynamicSchema,
  validateSettingDefinitions,
  OptionTypes,
  clampSettingRange,
} from '../src/generate';
import type { SettingsConfiguration } from '../src/generate';

describe('generateDynamicSchema', () => {
  it('should generate a schema for number settings with range', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'testNumber',
        description: 'A test number setting',
        type: 'number',
        default: 5,
        range: { min: 1, max: 10, step: 1 },
        component: 'slider',
        optionType: 'conversation',
        columnSpan: 2,
        label: 'Test Number Slider',
      },
    ];

    const schema = generateDynamicSchema(settings);
    const result = schema.safeParse({ testNumber: 6 });

    expect(result.success).toBeTruthy();
    expect(result['data']).toEqual({ testNumber: 6 });
  });

  it('should generate a schema for boolean settings', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'testBoolean',
        description: 'A test boolean setting',
        type: 'boolean',
        default: true,
        component: 'switch',
        optionType: 'model', // Only if relevant to your application's context
        columnSpan: 1,
        label: 'Test Boolean Switch',
      },
    ];

    const schema = generateDynamicSchema(settings);
    const result = schema.safeParse({ testBoolean: false });

    expect(result.success).toBeTruthy();
    expect(result['data']).toEqual({ testBoolean: false });
  });

  it('should generate a schema for string settings', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'testString',
        description: 'A test string setting',
        type: 'string',
        default: 'default value',
        component: 'input',
        optionType: 'model', // Optional and only if relevant
        columnSpan: 3,
        label: 'Test String Input',
        placeholder: 'Enter text here...',
        minText: 0, // Optional
        maxText: 100, // Optional
      },
    ];

    const schema = generateDynamicSchema(settings);
    const result = schema.safeParse({ testString: 'custom value' });

    expect(result.success).toBeTruthy();
    expect(result['data']).toEqual({ testString: 'custom value' });
  });

  it('should generate a schema for enum settings', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'testEnum',
        description: 'A test enum setting',
        type: 'enum',
        default: 'option1',
        options: ['option1', 'option2', 'option3'],
        enumMappings: {
          option1: 'First Option',
          option2: 'Second Option',
          option3: 'Third Option',
        },
        component: 'dropdown',
        columnSpan: 2,
        label: 'Test Enum Dropdown',
      },
    ];

    const schema = generateDynamicSchema(settings);
    const result = schema.safeParse({ testEnum: 'option2' });

    expect(result.success).toBeTruthy();
    expect(result['data']).toEqual({ testEnum: 'option2' });
  });

  it('should generate a schema for enum settings with empty string option', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'testEnumWithEmpty',
        description: 'A test enum setting with empty string',
        type: 'enum',
        default: '',
        options: ['', 'option1', 'option2'],
        enumMappings: {
          '': 'None',
          option1: 'First Option',
          option2: 'Second Option',
        },
        component: 'slider',
        columnSpan: 2,
        label: 'Test Enum with Empty String',
      },
    ];

    const schema = generateDynamicSchema(settings);
    const result = schema.safeParse({ testEnumWithEmpty: '' });

    expect(result.success).toBeTruthy();
    expect(result['data']).toEqual({ testEnumWithEmpty: '' });

    // Test with non-empty option
    const result2 = schema.safeParse({ testEnumWithEmpty: 'option1' });
    expect(result2.success).toBeTruthy();
    expect(result2['data']).toEqual({ testEnumWithEmpty: 'option1' });
  });

  it('should fail for incorrect enum value', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'testEnum',
        description: 'A test enum setting',
        type: 'enum',
        default: 'option1',
        options: ['option1', 'option2', 'option3'],
        component: 'dropdown',
      },
    ];

    const schema = generateDynamicSchema(settings);
    const result = schema.safeParse({ testEnum: 'option4' }); // This option does not exist

    expect(result.success).toBeFalsy();
  });

  it('should generate a schema for array settings', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'testArray',
        description: 'A test array setting',
        type: 'array',
        default: ['default', 'values'],
        component: 'tags', // Assuming 'tags' imply an array of strings
        optionType: OptionTypes.Custom,
        columnSpan: 3,
        label: 'Test Array Tags',
        minTags: 1, // Minimum number of tags
        maxTags: 5, // Maximum number of tags
      },
    ];

    const schema = generateDynamicSchema(settings);
    // Testing with right number of tags
    let result = schema.safeParse({ testArray: ['value1', 'value2', 'value3'] });

    expect(result.success).toBeTruthy();
    expect(result?.['data']).toEqual({ testArray: ['value1', 'value2', 'value3'] });

    // Testing with too few tags (should fail)
    result = schema.safeParse({ testArray: [] }); // Assuming minTags is 1, empty array should fail
    expect(result.success).toBeFalsy();
    if (!result.success) {
      // Additional check to ensure the failure is because of the minTags condition
      const issues = result.error.issues.filter(
        (issue) => issue.path.includes('testArray') && issue.code === 'too_small',
      );
      expect(issues.length).toBeGreaterThan(0); // Ensure there is at least one issue related to 'testArray' being too small
    }

    // Testing with too many tags (should fail)
    result = schema.safeParse({
      testArray: ['value1', 'value2', 'value3', 'value4', 'value5', 'value6'],
    }); // Assuming maxTags is 5, this should fail
    expect(result.success).toBeFalsy();
    if (!result.success) {
      // Additional check to ensure the failure is because of the maxTags condition
      const issues = result.error.issues.filter(
        (issue) => issue.path.includes('testArray') && issue.code === 'too_big',
      );
      expect(issues.length).toBeGreaterThan(0); // Ensure there is at least one issue related to 'testArray' being too big
    }
  });
});

describe('generateDynamicSchema with positiveMin', () => {
  const settings = [
    {
      key: 'thinkingBudget',
      type: 'number',
      component: 'input',
      range: { min: -1, max: 32768, positiveMin: 128 },
    },
  ] as SettingsConfiguration;

  it('accepts the sentinel and values at or above the floor', () => {
    const schema = generateDynamicSchema(settings);
    expect(schema.safeParse({ thinkingBudget: -1 }).success).toBe(true);
    expect(schema.safeParse({ thinkingBudget: 128 }).success).toBe(true);
    expect(schema.safeParse({ thinkingBudget: 32768 }).success).toBe(true);
  });

  it('rejects non-negative values below the floor', () => {
    const schema = generateDynamicSchema(settings);
    expect(schema.safeParse({ thinkingBudget: 0 }).success).toBe(false);
    expect(schema.safeParse({ thinkingBudget: 127 }).success).toBe(false);
  });
});

describe('positiveMin default validation', () => {
  const definition = (defaultValue: number): SettingsConfiguration => [
    {
      key: 'thinkingBudget',
      type: 'number',
      component: 'slider',
      optionType: 'custom',
      default: defaultValue,
      range: { min: -1, max: 32768, step: 1, positiveMin: 128 },
    },
  ];

  it('rejects a default between the sentinel and the positive floor', () => {
    for (const invalid of [0, 127]) {
      expect(() => validateSettingDefinitions(definition(invalid))).toThrow(
        /Must be -1 or at least 128/,
      );
    }
  });

  it('accepts the sentinel itself and any value at or above the floor', () => {
    expect(() => validateSettingDefinitions(definition(-1))).not.toThrow();
    expect(() => validateSettingDefinitions(definition(128))).not.toThrow();
  });
});

describe('positiveMin range validation', () => {
  /**
   * `default` is optional and this validator populates it, so a midpoint taken
   * across the sentinel gap would make an otherwise coherent definition fail
   * the validation in the same pass.
   */
  it('synthesizes a slider default inside the admissible interval', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'budget',
        type: 'number',
        component: 'slider',
        optionType: 'custom',
        range: { min: -1, max: 100, step: 1, positiveMin: 80 },
      },
    ];

    expect(() => validateSettingDefinitions(settings)).not.toThrow();
    expect(settings[0].default).toBe(90);
  });

  it('rejects a positive floor above the maximum', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'thinkingBudget',
        type: 'number',
        component: 'slider',
        optionType: 'custom',
        range: { min: -1, max: 100, step: 1, positiveMin: 200 },
      },
    ];

    expect(() => validateSettingDefinitions(settings)).toThrow(/cannot exceed max/);
  });
});

describe('clampSettingRange', () => {
  const proThinkingBudget = { min: -1, max: 32768, step: 1, positiveMin: 128 };

  it('preserves the negative sentinel', () => {
    expect(clampSettingRange(-1, proThinkingBudget)).toBe(-1);
  });

  it('clamps positive values below the model floor up to that floor', () => {
    expect(clampSettingRange(0, proThinkingBudget)).toBe(128);
    expect(clampSettingRange(127, proThinkingBudget)).toBe(128);
  });

  it('leaves values inside the supported positive range alone', () => {
    expect(clampSettingRange(128, proThinkingBudget)).toBe(128);
    expect(clampSettingRange(2000, proThinkingBudget)).toBe(2000);
  });

  it('still enforces the ceiling', () => {
    expect(clampSettingRange(40000, proThinkingBudget)).toBe(32768);
  });

  it('clamps values below the sentinel up to the sentinel', () => {
    expect(clampSettingRange(-2, proThinkingBudget)).toBe(-1);
  });

  /** The minimum is the sentinel whatever its sign, and the generated schema
   *  admits it outright, so the clamp must not lift it to the floor. */
  it('preserves a non-negative sentinel minimum', () => {
    const range = { min: 0, max: 100, step: 1, positiveMin: 10 };
    const settings: SettingsConfiguration = [
      {
        key: 'budget',
        type: 'number',
        component: 'slider',
        optionType: 'custom',
        range,
      },
    ];
    const schema = generateDynamicSchema(settings);

    expect(clampSettingRange(0, range)).toBe(0);
    expect(schema.safeParse({ budget: 0 }).success).toBe(true);
    /** Still inside the gap, so it lifts to the floor. */
    expect(clampSettingRange(5, range)).toBe(10);
    expect(clampSettingRange(-3, range)).toBe(0);
  });

  it('treats a zero positiveMin as a valid floor rather than a missing one', () => {
    const flash = { min: -1, max: 24576, step: 1, positiveMin: 0 };
    expect(clampSettingRange(0, flash)).toBe(0);
    expect(clampSettingRange(-1, flash)).toBe(-1);
  });

  /**
   * The generated schema admits the sentinel or the positive floor and nothing
   * between them, so a stored fraction has to resolve to one of those rather
   * than survive a normalization the schema then rejects.
   */
  it('resolves a value between the sentinel and the floor to the sentinel', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'thinkingBudget',
        type: 'number',
        component: 'slider',
        optionType: 'model',
        range: proThinkingBudget,
      },
    ];
    const schema = generateDynamicSchema(settings);

    for (const stored of [-0.5, -0.001]) {
      const clamped = clampSettingRange(stored, proThinkingBudget);
      expect(clamped).toBe(-1);
      expect(schema.safeParse({ thinkingBudget: stored }).success).toBe(false);
      expect(schema.safeParse({ thinkingBudget: clamped }).success).toBe(true);
    }
  });
});

describe('validateSettingDefinitions', () => {
  test('should throw error for Conversation optionType', () => {
    const validSettings: SettingsConfiguration = [
      {
        key: 'themeColor',
        component: 'input',
        type: 'string',
        default: '#ffffff',
        label: 'Theme Color',
        columns: 2,
        columnSpan: 1,
        optionType: OptionTypes.Conversation,
      },
    ];

    expect(() => validateSettingDefinitions(validSettings)).toThrow();
  });

  test('should throw error for Model optionType', () => {
    const validSettings: SettingsConfiguration = [
      {
        key: 'themeColor',
        component: 'input',
        type: 'string',
        default: '#ffffff',
        label: 'Theme Color',
        columns: 2,
        columnSpan: 1,
        optionType: OptionTypes.Model,
      },
    ];

    expect(() => validateSettingDefinitions(validSettings)).toThrow();
  });

  test('should not throw error for valid settings', () => {
    const validSettings: SettingsConfiguration = [
      {
        key: 'themeColor',
        component: 'input',
        type: 'string',
        default: '#ffffff',
        label: 'Theme Color',
        columns: 2,
        columnSpan: 1,
        optionType: OptionTypes.Custom,
      },
      {
        key: 'fontSize',
        component: 'slider',
        type: 'number',
        range: { min: 8, max: 36 },
        default: 14,
        columnSpan: 2,
        optionType: OptionTypes.Custom,
      },
    ];

    expect(() => validateSettingDefinitions(validSettings)).not.toThrow();
  });

  // Test for incorrectly configured columns
  test('should throw error for invalid columns configuration', () => {
    const invalidSettings: SettingsConfiguration = [
      {
        key: 'themeColor',
        component: 'input',
        type: 'string',
        columns: 5,
      },
    ];

    expect(() => validateSettingDefinitions(invalidSettings)).toThrow(ZodError);
  });

  test('should correctly handle columnSpan defaulting based on columns', () => {
    const settingsWithColumnAdjustment: SettingsConfiguration = [
      {
        key: 'fontSize',
        component: 'slider',
        type: 'number',
        columns: 4,
        range: { min: 8, max: 14 },
        default: 11,
        optionType: OptionTypes.Custom,
      },
    ];

    expect(() => validateSettingDefinitions(settingsWithColumnAdjustment)).not.toThrow();
  });

  // Test for label defaulting to key if not provided
  test('label should default to key if not explicitly set', () => {
    const settingsWithDefaultLabel: SettingsConfiguration = [
      {
        key: 'fontWeight',
        component: 'dropdown',
        type: 'string',
        options: ['normal', 'bold'],
        optionType: OptionTypes.Custom,
      },
    ];

    expect(() => validateSettingDefinitions(settingsWithDefaultLabel)).not.toThrow();
    expect(settingsWithDefaultLabel[0].label).toBe('fontWeight');
  });

  // Test for minText and maxText in input/textarea component
  test('should throw error for negative minText or maxText', () => {
    const settingsWithNegativeTextLimits: SettingsConfiguration = [
      { key: 'biography', component: 'textarea', type: 'string', minText: -1 },
    ];

    expect(() => validateSettingDefinitions(settingsWithNegativeTextLimits)).toThrow(ZodError);
  });

  // Validate optionType with tConversationSchema
  test('should throw error for optionType "conversation" not matching schema', () => {
    const settingsWithInvalidConversationOptionType: SettingsConfiguration = [
      { key: 'userAge', component: 'input', type: 'number', optionType: 'conversation' },
    ];

    expect(() => validateSettingDefinitions(settingsWithInvalidConversationOptionType)).toThrow(
      ZodError,
    );
  });

  // Test for columnSpan defaulting and label defaulting to key
  test('columnSpan defaults based on columns and label defaults to key if not set', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'textSize',
        type: 'number',
        component: 'slider',
        range: { min: 10, max: 20 },
        columns: 4,
        optionType: OptionTypes.Custom,
      },
    ];

    validateSettingDefinitions(settings); // Perform validation which also mutates settings with default values

    expect(settings[0].columnSpan).toBe(2); // Expects columnSpan to default based on columns
    expect(settings[0].label).toBe('textSize'); // Expects label to default to key
  });

  // Test for errors thrown due to invalid columns value
  test('throws error if columns value is out of range', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'themeMode',
        type: 'string',
        component: 'dropdown',
        options: ['dark', 'light'],
        columns: 5,
      },
    ];

    expect(() => validateSettingDefinitions(settings)).toThrow(ZodError);
  });

  // Test range validation for slider component
  test('slider component range validation', () => {
    const settings: SettingsConfiguration = [
      { key: 'volume', type: 'number', component: 'slider' }, // Missing range
    ];

    expect(() => validateSettingDefinitions(settings)).toThrow(ZodError);
  });

  // Test options validation for enum type in slider component
  test('slider component with enum type requires at least 2 options', () => {
    const settings: SettingsConfiguration = [
      { key: 'color', type: 'enum', component: 'slider', options: ['red'] }, // Not enough options
    ];

    expect(() => validateSettingDefinitions(settings)).toThrow(ZodError);
  });

  // Test checkbox component options validation
  test('checkbox component must have 1-2 options if options are provided', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'agreeToTerms',
        type: 'boolean',
        component: 'checkbox',
        options: ['Yes', 'No', 'Maybe'],
      }, // Too many options
    ];

    expect(() => validateSettingDefinitions(settings)).toThrow(ZodError);
  });

  // Test dropdown component options validation
  test('dropdown component requires at least 2 options', () => {
    const settings: SettingsConfiguration = [
      { key: 'country', type: 'enum', component: 'dropdown', options: ['USA'] }, // Not enough options
    ];

    expect(() => validateSettingDefinitions(settings)).toThrow(ZodError);
  });

  // Validate minText and maxText constraints in input and textarea
  test('validate minText and maxText constraints', () => {
    const settings: SettingsConfiguration = [
      { key: 'biography', type: 'string', component: 'textarea', minText: 10, maxText: 5 }, // Incorrect minText and maxText
    ];

    expect(() => validateSettingDefinitions(settings)).toThrow(ZodError);
  });

  // Validate optionType constraint with tConversationSchema
  test('validate optionType constraint with tConversationSchema', () => {
    const settings: SettingsConfiguration = [
      { key: 'userAge', type: 'number', component: 'input', optionType: 'conversation' }, // No corresponding schema in tConversationSchema
    ];

    expect(() => validateSettingDefinitions(settings)).toThrow(ZodError);
  });

  // Validate correct handling of boolean settings with default values
  test('correct handling of boolean settings with defaults', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'enableFeatureX',
        type: 'boolean',
        component: 'switch',
        optionType: OptionTypes.Custom,
      }, // Missing default, should default to false
    ];

    validateSettingDefinitions(settings); // This would populate default values where missing

    expect(settings[0].default).toBe(false); // Expects default to be false for boolean without explicit default
  });

  // Validate that number slider without default uses middle of range
  test('number slider without default uses middle of range', () => {
    const settings: SettingsConfiguration = [
      {
        key: 'brightness',
        type: 'number',
        component: 'slider',
        range: { min: 0, max: 100 },
        optionType: OptionTypes.Custom,
      }, // Missing default
    ];

    validateSettingDefinitions(settings); // This would populate default values where missing

    expect(settings[0].default).toBe(50); // Expects default to be midpoint of range
  });

  // Test for validating minTags and maxTags constraints
  test('should validate minTags and maxTags constraints', () => {
    const settingsWithTagsConstraints: SettingsConfiguration = [
      {
        key: 'selectedTags',
        component: 'tags',
        type: 'array',
        default: ['tag1'], // Only one tag by default
        minTags: 2, // Requires at least 2 tags, which should cause validation to fail
        maxTags: 4,
        optionType: OptionTypes.Custom,
      },
    ];

    expect(() => validateSettingDefinitions(settingsWithTagsConstraints)).toThrow(ZodError);
  });

  // Test for ensuring default values for tags are arrays
  test('should ensure default values for tags are arrays', () => {
    const settingsWithInvalidDefaultForTags: SettingsConfiguration = [
      {
        key: 'favoriteTags',
        component: 'tags',
        type: 'array',
        default: 'notAnArray', // Incorrect default type
        optionType: OptionTypes.Custom,
      },
    ];

    expect(() => validateSettingDefinitions(settingsWithInvalidDefaultForTags)).toThrow(ZodError);
  });

  // Test for array settings without default values should not throw if constraints are satisfied
  test('array settings without defaults should not throw if constraints are met', () => {
    const settingsWithNoDefaultButValidTags: SettingsConfiguration = [
      {
        key: 'userTags',
        component: 'tags',
        type: 'array',
        minTags: 1, // Requires at least 1 tag
        maxTags: 5, // Allows up to 5 tags
        optionType: OptionTypes.Custom,
      },
    ];

    // No default is set, but since the constraints are potentially met (depends on user input), this should not throw
    expect(() => validateSettingDefinitions(settingsWithNoDefaultButValidTags)).not.toThrow();
  });

  // Test for ensuring maxTags is respected in default array values
  test('should ensure maxTags is respected for default array values', () => {
    const settingsExceedingMaxTags: SettingsConfiguration = [
      {
        key: 'interestTags',
        component: 'tags',
        type: 'array',
        default: ['music', 'movies', 'books', 'travel', 'cooking', 'sports'], // 6 tags
        maxTags: 5, // Exceeds the maxTags limit
        optionType: OptionTypes.Custom,
      },
    ];

    expect(() => validateSettingDefinitions(settingsExceedingMaxTags)).toThrow(ZodError);
  });

  // Test for incomplete enumMappings
  test('should throw error for incomplete enumMappings', () => {
    const settingsWithIncompleteEnumMappings: SettingsConfiguration = [
      {
        key: 'displayMode',
        type: 'enum',
        component: 'dropdown',
        options: ['light', 'dark', 'auto'],
        enumMappings: {
          light: 'Light Mode',
          dark: 'Dark Mode',
          // Missing mapping for 'auto'
        },
        optionType: OptionTypes.Custom,
      },
    ];

    expect(() => validateSettingDefinitions(settingsWithIncompleteEnumMappings)).toThrow(ZodError);
  });

  // Test for complete enumMappings including empty string
  test('should not throw error for complete enumMappings including empty string', () => {
    const settingsWithCompleteEnumMappings: SettingsConfiguration = [
      {
        key: 'selectionMode',
        type: 'enum',
        component: 'slider',
        options: ['', 'single', 'multiple'],
        enumMappings: {
          '': 'None',
          single: 'Single Selection',
          multiple: 'Multiple Selection',
        },
        default: '',
        optionType: OptionTypes.Custom,
      },
    ];

    expect(() => validateSettingDefinitions(settingsWithCompleteEnumMappings)).not.toThrow();
  });
});

const settingsConfiguration: SettingsConfiguration = [
  {
    key: 'temperature',
    description:
      'Higher values = more random, while lower values = more focused and deterministic. We recommend altering this or Top P but not both.',
    type: 'number',
    default: 1,
    range: {
      min: 0,
      max: 2,
      step: 0.01,
    },
    component: 'slider',
    optionType: OptionTypes.Custom,
  },
  {
    key: 'top_p',
    description:
      'An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with top_p probability mass. So 0.1 means only the tokens comprising the top 10% probability mass are considered. We recommend altering this or temperature but not both.',
    type: 'number',
    default: 1,
    range: {
      min: 0,
      max: 1,
      step: 0.01,
    },
    component: 'slider',
    optionType: OptionTypes.Custom,
  },
  {
    key: 'presence_penalty',
    description:
      "Number between -2.0 and 2.0. Positive values penalize new tokens based on whether they appear in the text so far, increasing the model's likelihood to talk about new topics.",
    type: 'number',
    default: 0,
    range: {
      min: -2,
      max: 2,
      step: 0.01,
    },
    component: 'slider',
    optionType: OptionTypes.Custom,
  },
  {
    key: 'frequency_penalty',
    description:
      "Number between -2.0 and 2.0. Positive values penalize new tokens based on their existing frequency in the text so far, decreasing the model's likelihood to repeat the same line verbatim.",
    type: 'number',
    default: 0,
    range: {
      min: -2,
      max: 2,
      step: 0.01,
    },
    component: 'slider',
    optionType: OptionTypes.Custom,
  },
  {
    key: 'resendFiles',
    description:
      'Resend all previously attached files. Note: this will increase token cost and you may experience errors with many attachments.',
    type: 'boolean',
    default: true,
    component: 'switch',
    optionType: OptionTypes.Custom,
  },
  {
    key: 'imageDetail',
    description:
      'The resolution for Vision requests. "Low" is cheaper and faster, "High" is more detailed and expensive, and "Auto" will automatically choose between the two based on the image resolution.',
    type: 'enum',
    default: 'auto',
    options: ['low', 'high', 'auto'],
    component: 'slider',
    optionType: OptionTypes.Custom,
  },
  {
    key: 'promptPrefix',
    type: 'string',
    default: '',
    component: 'input',
    optionType: OptionTypes.Custom,
    placeholder: 'Set custom instructions to include in System Message. Default: none',
  },
  {
    key: 'chatGptLabel',
    type: 'string',
    default: '',
    component: 'input',
    optionType: OptionTypes.Custom,
    placeholder: 'Set a custom name for your AI',
  },
];

describe('Settings Validation and Schema Generation', () => {
  // Test 1: Validate settings definitions do not throw for valid configuration
  test('validateSettingDefinitions does not throw for valid configuration', () => {
    expect(() => validateSettingDefinitions(settingsConfiguration)).not.toThrow();
  });

  test('validateSettingDefinitions throws for invalid type in settings', () => {
    const settingsWithInvalidType = [
      ...settingsConfiguration,
      {
        key: 'newSetting',
        description: 'A setting with an unsupported type',
        type: 'unsupportedType', // Assuming 'unsupportedType' is not supported
        component: 'input',
      },
    ];

    expect(() =>
      validateSettingDefinitions(settingsWithInvalidType as SettingsConfiguration),
    ).toThrow();
  });

  test('validateSettingDefinitions throws for missing required fields', () => {
    const settingsMissingRequiredField = [
      ...settingsConfiguration,
      {
        key: 'incompleteSetting',
        type: 'number',
        // Missing 'component',
      },
    ];

    expect(() =>
      validateSettingDefinitions(settingsMissingRequiredField as SettingsConfiguration),
    ).toThrow();
  });

  test('validateSettingDefinitions throws for default value out of range', () => {
    const settingsOutOfRange = [
      ...settingsConfiguration,
      {
        key: 'rangeTestSetting',
        description: 'A setting with default value out of specified range',
        type: 'number',
        default: 5,
        range: {
          min: 0,
          max: 1,
        },
        component: 'slider',
      },
    ];

    expect(() => validateSettingDefinitions(settingsOutOfRange as SettingsConfiguration)).toThrow();
  });

  test('validateSettingDefinitions throws for enum setting with incorrect default', () => {
    const settingsWithIncorrectEnumDefault = [
      ...settingsConfiguration,
      {
        key: 'enumSetting',
        description: 'Enum setting with a default not in options',
        type: 'enum',
        default: 'unlistedOption',
        options: ['option1', 'option2'],
        component: 'dropdown',
      },
    ];

    expect(() =>
      validateSettingDefinitions(settingsWithIncorrectEnumDefault as SettingsConfiguration),
    ).toThrow();
  });

  // Test 2: Generate dynamic schema and validate correct input
  test('generateDynamicSchema generates a schema that validates correct input', () => {
    const schema = generateDynamicSchema(settingsConfiguration);
    const validInput = {
      temperature: 0.5,
      top_p: 0.8,
      presence_penalty: 1,
      frequency_penalty: -1,
      resendFiles: true,
      imageDetail: 'high',
      promptPrefix: 'Hello, AI.',
      chatGptLabel: 'My Custom AI',
    };

    expect(schema.parse(validInput)).toEqual(validInput);
  });

  // Test 3: Generate dynamic schema and catch invalid input
  test('generateDynamicSchema generates a schema that catches invalid input and provides detailed errors', async () => {
    const schema = generateDynamicSchema(settingsConfiguration);
    const invalidInput: z.infer<typeof schema> = {
      temperature: 2.5, // Out of range
      top_p: -0.5, // Out of range
      presence_penalty: 3, // Out of range
      frequency_penalty: -3, // Out of range
      resendFiles: 'yes', // Wrong type
      imageDetail: 'ultra', // Invalid option
      promptPrefix: 123, // Wrong type
      chatGptLabel: true, // Wrong type
    };

    const result = schema.safeParse(invalidInput);
    expect(result.success).toBeFalsy();
    if (!result.success) {
      const errorPaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(errorPaths).toContain('temperature');
      expect(errorPaths).toContain('top_p');
      expect(errorPaths).toContain('presence_penalty');
      expect(errorPaths).toContain('frequency_penalty');
      expect(errorPaths).toContain('resendFiles');
      expect(errorPaths).toContain('imageDetail');
      expect(errorPaths).toContain('promptPrefix');
      expect(errorPaths).toContain('chatGptLabel');
    }
  });
});
