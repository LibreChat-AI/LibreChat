import { z, ZodArray, ZodError, ZodIssueCode } from 'zod';
import type { ZodIssue } from 'zod';
import type { TConversation, TSetOption, TPreset } from './schemas';
import { tConversationSchema, googleSettings as google, openAISettings as openAI } from './schemas';

export type GoogleSettings = Partial<typeof google>;
export type OpenAISettings = Partial<typeof google>;

export type ComponentType =
  | 'input'
  | 'textarea'
  | 'slider'
  | 'checkbox'
  | 'switch'
  | 'dropdown'
  | 'combobox'
  | 'tags';

export type OptionType = 'conversation' | 'model' | 'custom';

export type Option = Record<string, unknown> & {
  label?: string;
  value: string | number | null;
};

export type OptionWithIcon = Option & { icon?: React.ReactNode };

export enum ComponentTypes {
  Input = 'input',
  Textarea = 'textarea',
  Slider = 'slider',
  Checkbox = 'checkbox',
  Switch = 'switch',
  Dropdown = 'dropdown',
  Combobox = 'combobox',
  Tags = 'tags',
}

export enum SettingTypes {
  Number = 'number',
  Boolean = 'boolean',
  String = 'string',
  Enum = 'enum',
  Array = 'array',
}

export enum OptionTypes {
  Conversation = 'conversation',
  Model = 'model',
  Custom = 'custom',
}
export interface SettingDefinition {
  key: string;
  description?: string;
  type: 'number' | 'boolean' | 'string' | 'enum' | 'array';
  default?: number | boolean | string | string[];
  showLabel?: boolean;
  showDefault?: boolean;
  options?: string[];
  range?: SettingRange;
  enumMappings?: Record<string, number | boolean | string>;
  component: ComponentType;
  optionType?: OptionType;
  columnSpan?: number;
  columns?: number;
  label?: string;
  placeholder?: string;
  labelCode?: boolean;
  placeholderCode?: boolean;
  descriptionCode?: boolean;
  minText?: number;
  maxText?: number;
  minTags?: number; // Specific to tags component
  maxTags?: number; // Specific to tags component
  includeInput?: boolean; // Specific to slider component
  descriptionSide?: 'top' | 'right' | 'bottom' | 'left';
  items?: OptionWithIcon[]; // Specific to combobox component
  searchPlaceholder?: string; // Specific to combobox component
  selectPlaceholder?: string; // Specific to combobox component
  searchPlaceholderCode?: boolean; // Specific to combobox component
  selectPlaceholderCode?: boolean; // Specific to combobox component
}

export type DynamicSettingProps = Partial<SettingDefinition> & {
  readonly?: boolean;
  settingKey: string;
  setOption: TSetOption;
  conversation: Partial<TConversation> | Partial<TPreset> | null;
  defaultValue?: number | boolean | string | string[];
  className?: string;
  inputClassName?: string;
};

const requiredSettingFields = ['key', 'type', 'component'];

export interface SettingRange {
  min: number;
  max: number;
  step?: number;
  /**
   * Inclusive floor for non-negative values. Use when `min` is a sentinel
   * (Google thinkingBudget `-1` for auto) and positive values have a higher
   * documented minimum.
   */
  positiveMin?: number;
  /**
   * Set when this range came from the selected model rather than the shared
   * fallback. Only then is it safe to normalize a stored value against it: a
   * model that does not use the parameter leaves the generic range in place,
   * and clamping to that would discard a value set for another model.
   */
  modelSpecific?: boolean;
}

export function clampSettingRange(value: number, range: SettingRange): number {
  if (range.positiveMin != null) {
    /** The minimum carries its own meaning here (Google's -1 for automatic),
     *  and the schema admits it outright, so it survives rather than being
     *  lifted to the floor. It need not be negative to be the sentinel. */
    if (value === range.min) {
      return range.min;
    }
    /** Below the sentinel there is nothing admissible to lift to, so the value
     *  resolves to it. Between the sentinel and the floor, the floor is the
     *  nearest value the generated schema accepts. */
    if (value < Math.max(range.min, 0)) {
      return range.min;
    }
    return Math.min(Math.max(value, range.positiveMin), range.max);
  }
  return Math.min(Math.max(value, range.min), range.max);
}

export type SettingsConfiguration = SettingDefinition[];

export function generateDynamicSchema(settings: SettingsConfiguration) {
  const schemaFields: { [key: string]: z.ZodTypeAny } = {};

  for (const setting of settings) {
    const {
      key,
      type,
      default: defaultValue,
      range,
      options,
      minText,
      maxText,
      minTags,
      maxTags,
    } = setting;

    if (type === SettingTypes.Number) {
      let numberSchema = z.number();
      if (range) {
        numberSchema = numberSchema.min(range.min);
        numberSchema = numberSchema.max(range.max);
      }
      /** Widened deliberately: refine returns ZodEffects, not ZodNumber, and
       *  the number-specific chaining is already done above. */
      let schema: z.ZodTypeAny = numberSchema;
      if (range?.positiveMin != null) {
        /** Mirrors clampSettingRange so the generated schema and the clamp
         *  agree: `min` only admits the sentinel, and any non-negative value
         *  must clear the documented floor. */
        const { positiveMin, min } = range;
        schema = numberSchema.refine(
          (value) => value === min || value >= positiveMin,
          `Expected ${min} or a value of at least ${positiveMin}`,
        );
      }
      if (typeof defaultValue === 'number') {
        schemaFields[key] = schema.default(defaultValue);
      } else {
        schemaFields[key] = schema;
      }
      continue;
    }

    if (type === SettingTypes.Boolean) {
      const schema = z.boolean();
      if (typeof defaultValue === 'boolean') {
        schemaFields[key] = schema.default(defaultValue);
      } else {
        schemaFields[key] = schema;
      }
      continue;
    }

    if (type === SettingTypes.String) {
      let schema = z.string();
      if (minText) {
        schema = schema.min(minText);
      }
      if (maxText) {
        schema = schema.max(maxText);
      }
      if (typeof defaultValue === 'string') {
        schemaFields[key] = schema.default(defaultValue);
      } else {
        schemaFields[key] = schema;
      }
      continue;
    }

    if (type === SettingTypes.Enum) {
      if (!options || options.length === 0) {
        console.warn(`Missing or empty 'options' for enum setting '${key}'.`);
        continue;
      }

      const schema = z.enum(options as [string, ...string[]]);
      if (typeof defaultValue === 'string') {
        schemaFields[key] = schema.default(defaultValue);
      } else {
        schemaFields[key] = schema;
      }
      continue;
    }

    if (type === SettingTypes.Array) {
      let schema: z.ZodSchema = z.array(z.string().or(z.number()));
      if (minTags && schema instanceof ZodArray) {
        schema = schema.min(minTags);
      }
      if (maxTags && schema instanceof ZodArray) {
        schema = schema.max(maxTags);
      }

      if (defaultValue && Array.isArray(defaultValue)) {
        schema = schema.default(defaultValue);
      }

      schemaFields[key] = schema;
      continue;
    }

    console.warn(`Unsupported setting type: ${type}`);
  }

  return z.object(schemaFields);
}

const ZodTypeToSettingType: Record<string, string | undefined> = {
  ZodString: 'string',
  ZodNumber: 'number',
  ZodBoolean: 'boolean',
};

const minColumns = 1;
const maxColumns = 4;
const minSliderOptions = 2;
const minDropdownOptions = 2;
const minComboboxOptions = 2;

/**
 * Validates the provided setting using the constraints unique to each component type.
 * @throws {ZodError} Throws a ZodError if any validation fails.
 */
export function validateSettingDefinitions(settings: SettingsConfiguration): void {
  const errors: ZodIssue[] = [];
  // Validate columns
  const columnsSet = new Set<number>();
  for (const setting of settings) {
    if (setting.columns !== undefined) {
      if (setting.columns < minColumns || setting.columns > maxColumns) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Invalid columns value for setting ${setting.key}. Must be between ${minColumns} and ${maxColumns}.`,
          path: ['columns'],
        });
      } else {
        columnsSet.add(setting.columns);
      }
    }
  }

  const columns = columnsSet.size === 1 ? columnsSet.values().next().value : 2;

  for (const setting of settings) {
    for (const field of requiredSettingFields) {
      if (setting[field as keyof SettingDefinition] === undefined) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Missing required field ${field} for setting ${setting.key}.`,
          path: [field],
        });
      }
    }

    // check accepted types
    const settingTypes = Object.values(SettingTypes);
    if (!settingTypes.includes(setting.type as SettingTypes)) {
      errors.push({
        code: ZodIssueCode.custom,
        message: `Invalid type for setting ${setting.key}. Must be one of ${settingTypes.join(
          ', ',
        )}.`,
        path: ['type'],
      });
    }

    // Predefined constraints based on components
    if (
      (setting.component === ComponentTypes.Tags && setting.type !== SettingTypes.Array) ||
      (setting.component !== ComponentTypes.Tags && setting.type === SettingTypes.Array)
    ) {
      errors.push({
        code: ZodIssueCode.custom,
        message: `Tags component for setting ${setting.key} must have type array.`,
        path: ['type'],
      });
    }

    if (setting.component === ComponentTypes.Tags) {
      if (setting.minTags !== undefined && setting.minTags < 0) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Invalid minTags value for setting ${setting.key}. Must be non-negative.`,
          path: ['minTags'],
        });
      }
      if (setting.maxTags !== undefined && setting.maxTags < 0) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Invalid maxTags value for setting ${setting.key}. Must be non-negative.`,
          path: ['maxTags'],
        });
      }
      if (setting.default && !Array.isArray(setting.default)) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Invalid default value for setting ${setting.key}. Must be an array.`,
          path: ['default'],
        });
      }
      if (setting.default && setting.maxTags && (setting.default as []).length > setting.maxTags) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Invalid default value for setting ${setting.key}. Must have at most ${setting.maxTags} tags.`,
          path: ['default'],
        });
      }
      if (setting.default && setting.minTags && (setting.default as []).length < setting.minTags) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Invalid default value for setting ${setting.key}. Must have at least ${setting.minTags} tags.`,
          path: ['default'],
        });
      }
      if (!setting.default) {
        setting.default = [];
      }
    }

    if (
      setting.component === ComponentTypes.Input ||
      setting.component === ComponentTypes.Textarea
    ) {
      if (setting.type === SettingTypes.Number && setting.component === ComponentTypes.Textarea) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Textarea component for setting ${setting.key} must have type string.`,
          path: ['type'],
        });
        // continue;
      }

      if (
        setting.minText !== undefined &&
        setting.maxText !== undefined &&
        setting.minText > setting.maxText
      ) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `For setting ${setting.key}, minText cannot be greater than maxText.`,
          path: [setting.key, 'minText', 'maxText'],
        });
        // continue;
      }
      if (!setting.placeholder) {
        setting.placeholder = '';
      } // Default placeholder
    }

    if (setting.component === ComponentTypes.Slider) {
      if (setting.type === SettingTypes.Number && !setting.range) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Slider component for setting ${setting.key} must have a range if type is number.`,
          path: ['range'],
        });
        // continue;
      }
      if (
        setting.type === SettingTypes.Enum &&
        (!setting.options || setting.options.length < minSliderOptions)
      ) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Slider component for setting ${setting.key} requires at least ${minSliderOptions} options for enum type.`,
          path: ['options'],
        });
        // continue;
      }
      setting.includeInput =
        setting.type === SettingTypes.Number ? (setting.includeInput ?? true) : false; // Default to true if type is number
    }

    if (setting.component === ComponentTypes.Slider && setting.type === SettingTypes.Number) {
      if (setting.default === undefined && setting.range) {
        /** The midpoint of the admissible interval, which a positive floor
         *  narrows: the span between the sentinel and that floor holds no value
         *  the generated schema accepts, so a midpoint taken across it would
         *  fail the validation below. */
        const floor = Math.max(setting.range.min, setting.range.positiveMin ?? setting.range.min);
        setting.default = Math.round((floor + setting.range.max) / 2);
      }
    }

    if (
      setting.component === ComponentTypes.Checkbox ||
      setting.component === ComponentTypes.Switch
    ) {
      if (setting.options && setting.options.length > 2) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Checkbox/Switch component for setting ${setting.key} must have 1-2 options.`,
          path: ['options'],
        });
        // continue;
      }
      if (!setting.default && setting.type === SettingTypes.Boolean) {
        setting.default = false; // Default to false if type is boolean
      }
    }

    if (setting.component === ComponentTypes.Dropdown) {
      if (!setting.options || setting.options.length < minDropdownOptions) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Dropdown component for setting ${setting.key} requires at least ${minDropdownOptions} options.`,
          path: ['options'],
        });
        // continue;
      }
      if (!setting.default && setting.options && setting.options.length > 0) {
        setting.default = setting.options[0]; // Default to first option if not specified
      }
    }

    if (setting.component === ComponentTypes.Combobox) {
      if (!setting.options || setting.options.length < minComboboxOptions) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Combobox component for setting ${setting.key} requires at least ${minComboboxOptions} options.`,
          path: ['options'],
        });
      }
      if (!setting.default && setting.options && setting.options.length > 0) {
        setting.default = setting.options[0];
      }
    }

    // Default columnSpan
    if (!setting.columnSpan) {
      setting.columnSpan = Math.floor((columns ?? 0) / 2);
    }

    // Default label to key
    if (!setting.label) {
      setting.label = setting.key;
    }

    // Validate minText and maxText for input/textarea
    if (
      setting.component === ComponentTypes.Input ||
      setting.component === ComponentTypes.Textarea
    ) {
      if (setting.minText !== undefined && setting.minText < 0) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Invalid minText value for setting ${setting.key}. Must be non-negative.`,
          path: ['minText'],
        });
      }
      if (setting.maxText !== undefined && setting.maxText < 0) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Invalid maxText value for setting ${setting.key}. Must be non-negative.`,
          path: ['maxText'],
        });
      }
    }

    // Validate optionType and conversation schema
    if (setting.optionType !== OptionTypes.Custom) {
      const conversationSchema =
        tConversationSchema.shape[setting.key as keyof Omit<TConversation, 'disableParams'>];
      if (!conversationSchema) {
        errors.push({
          code: ZodIssueCode.custom,
          message: `Setting ${setting.key} with optionType "${setting.optionType}" must be defined in tConversationSchema.`,
          path: ['optionType'],
        });
      } else {
        const zodType = conversationSchema._def.typeName;
        const settingTypeEquivalent = ZodTypeToSettingType[zodType] || null;
        if (settingTypeEquivalent !== setting.type) {
          errors.push({
            code: ZodIssueCode.custom,
            message: `Setting ${setting.key} with optionType "${setting.optionType}" must match the type defined in tConversationSchema.`,
            path: ['optionType'],
          });
        }
      }
    }

    /* Default value checks */
    if (
      setting.type === SettingTypes.Number &&
      isNaN(setting.default as number) &&
      setting.default != null
    ) {
      errors.push({
        code: ZodIssueCode.custom,
        message: `Invalid default value for setting ${setting.key}. Must be a number.`,
        path: ['default'],
      });
    }

    if (
      setting.type === SettingTypes.Boolean &&
      typeof setting.default !== 'boolean' &&
      setting.default != null
    ) {
      errors.push({
        code: ZodIssueCode.custom,
        message: `Invalid default value for setting ${setting.key}. Must be a boolean.`,
        path: ['default'],
      });
    }

    if (
      (setting.type === SettingTypes.String || setting.type === SettingTypes.Enum) &&
      typeof setting.default !== 'string' &&
      setting.default != null
    ) {
      errors.push({
        code: ZodIssueCode.custom,
        message: `Invalid default value for setting ${setting.key}. Must be a string.`,
        path: ['default'],
      });
    }

    if (
      setting.type === SettingTypes.Enum &&
      setting.options &&
      !setting.options.includes(setting.default as string)
    ) {
      errors.push({
        code: ZodIssueCode.custom,
        message: `Invalid default value for setting ${
          setting.key
        }. Must be one of the options: [${setting.options.join(', ')}].`,
        path: ['default'],
      });
    }

    if (
      setting.type === SettingTypes.Number &&
      setting.range &&
      typeof setting.default === 'number' &&
      (setting.default < setting.range.min || setting.default > setting.range.max)
    ) {
      errors.push({
        code: ZodIssueCode.custom,
        message: `Invalid default value for setting ${setting.key}. Must be within the range [${setting.range.min}, ${setting.range.max}].`,
        path: ['default'],
      });
    }

    if (
      setting.type === SettingTypes.Number &&
      setting.range?.positiveMin != null &&
      setting.range.positiveMin > setting.range.max
    ) {
      errors.push({
        code: ZodIssueCode.custom,
        message: `Invalid range for setting ${setting.key}. positiveMin (${setting.range.positiveMin}) cannot exceed max (${setting.range.max}).`,
        path: ['range'],
      });
    }

    if (
      setting.type === SettingTypes.Number &&
      setting.range?.positiveMin != null &&
      typeof setting.default === 'number' &&
      setting.default !== setting.range.min &&
      setting.default < setting.range.positiveMin
    ) {
      errors.push({
        code: ZodIssueCode.custom,
        message: `Invalid default value for setting ${setting.key}. Must be ${setting.range.min} or at least ${setting.range.positiveMin}.`,
        path: ['default'],
      });
    }

    // Validate enumMappings
    if (setting.enumMappings && setting.type === SettingTypes.Enum && setting.options) {
      for (const option of setting.options) {
        if (!(option in setting.enumMappings)) {
          errors.push({
            code: ZodIssueCode.custom,
            message: `Missing enumMapping for option "${option}" in setting ${setting.key}.`,
            path: ['enumMappings'],
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new ZodError(errors);
  }
}

export const generateOpenAISchema = (customOpenAI: OpenAISettings) => {
  const defaults = { ...openAI, ...customOpenAI };
  return tConversationSchema
    .pick({
      model: true,
      chatGptLabel: true,
      promptPrefix: true,
      temperature: true,
      top_p: true,
      presence_penalty: true,
      frequency_penalty: true,
      resendFiles: true,
      imageDetail: true,
      maxContextTokens: true,
    })
    .transform((obj) => ({
      ...obj,
      model: obj.model ?? defaults.model.default,
      chatGptLabel: obj.chatGptLabel ?? null,
      promptPrefix: obj.promptPrefix ?? null,
      temperature: obj.temperature ?? defaults.temperature.default,
      top_p: obj.top_p ?? defaults.top_p.default,
      presence_penalty: obj.presence_penalty ?? defaults.presence_penalty.default,
      frequency_penalty: obj.frequency_penalty ?? defaults.frequency_penalty.default,
      resendFiles:
        typeof obj.resendFiles === 'boolean' ? obj.resendFiles : defaults.resendFiles.default,
      imageDetail: obj.imageDetail ?? defaults.imageDetail.default,
      maxContextTokens: obj.maxContextTokens ?? undefined,
    }))
    .catch(() => ({
      model: defaults.model.default,
      chatGptLabel: null,
      promptPrefix: null,
      temperature: defaults.temperature.default,
      top_p: defaults.top_p.default,
      presence_penalty: defaults.presence_penalty.default,
      frequency_penalty: defaults.frequency_penalty.default,
      resendFiles: defaults.resendFiles.default,
      imageDetail: defaults.imageDetail.default,
      maxContextTokens: undefined,
    }));
};

export const generateGoogleSchema = (customGoogle: GoogleSettings) => {
  const defaults = { ...google, ...customGoogle };
  return tConversationSchema
    .pick({
      model: true,
      modelLabel: true,
      promptPrefix: true,
      examples: true,
      temperature: true,
      maxOutputTokens: true,
      topP: true,
      topK: true,
      maxContextTokens: true,
    })
    .transform((obj) => {
      return {
        ...obj,
        model: obj.model ?? defaults.model.default,
        modelLabel: obj.modelLabel ?? null,
        promptPrefix: obj.promptPrefix ?? null,
        examples: obj.examples ?? [{ input: { content: '' }, output: { content: '' } }],
        temperature: obj.temperature ?? defaults.temperature.default,
        maxOutputTokens:
          obj.maxOutputTokens ??
          defaults.maxOutputTokens.reset(obj.model ?? defaults.model.default),
        topP: obj.topP ?? defaults.topP.default,
        topK: obj.topK ?? defaults.topK.default,
        maxContextTokens: obj.maxContextTokens ?? undefined,
      };
    })
    .catch(() => ({
      model: defaults.model.default,
      modelLabel: null,
      promptPrefix: null,
      examples: [{ input: { content: '' }, output: { content: '' } }],
      temperature: defaults.temperature.default,
      maxOutputTokens: defaults.maxOutputTokens.default,
      topP: defaults.topP.default,
      topK: defaults.topK.default,
      maxContextTokens: undefined,
    }));
};
