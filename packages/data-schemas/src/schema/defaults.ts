import { Schema } from 'mongoose';
import { CODE_APPROVAL_MODES, CODE_ENVIRONMENT_MODES } from 'librechat-data-provider';

// @ts-ignore
export const conversationPreset: {
  endpoint: {
    type: StringConstructor;
    default: null;
    required: boolean;
  };
  endpointType: {
    type: StringConstructor;
  };
  // for azureOpenAI, openAI only
  model: {
    type: StringConstructor;
    required: boolean;
  };
  // for bedrock only
  region: {
    type: StringConstructor;
    required: boolean;
  };
  // for azureOpenAI, openAI only
  chatGptLabel: {
    type: StringConstructor;
    required: boolean;
  };
  // for google only
  examples: {
    type: {
      type: typeof Schema.Types.Mixed;
    }[];
    default: undefined;
  };
  modelLabel: {
    type: StringConstructor;
    required: boolean;
  };
  promptPrefix: {
    type: StringConstructor;
    required: boolean;
  };
  temperature: {
    type: NumberConstructor;
    required: boolean;
  };
  top_p: {
    type: NumberConstructor;
    required: boolean;
  };
  // for google only
  topP: {
    type: NumberConstructor;
    required: boolean;
  };
  topK: {
    type: NumberConstructor;
    required: boolean;
  };
  maxOutputTokens: {
    type: NumberConstructor;
    required: boolean;
  };
  maxTokens: {
    type: NumberConstructor;
    required: boolean;
  };
  presence_penalty: {
    type: NumberConstructor;
    required: boolean;
  };
  frequency_penalty: {
    type: NumberConstructor;
    required: boolean;
  };
  file_ids: {
    type: {
      type: StringConstructor;
    }[];
    default: undefined;
  };
  // deprecated
  resendImages: {
    type: BooleanConstructor;
  };
  /* Anthropic only */
  promptCache: {
    type: BooleanConstructor;
  };
  promptCacheTtl: {
    type: StringConstructor;
  };
  thinking: {
    type: BooleanConstructor;
  };
  thinkingBudget: {
    type: NumberConstructor;
  };
  thinkingLevel: {
    type: StringConstructor;
  };
  effort: {
    type: StringConstructor;
  };
  system: {
    type: StringConstructor;
  };
  // files
  resendFiles: {
    type: BooleanConstructor;
  };
  imageDetail: {
    type: StringConstructor;
  };
  /* agents */
  agent_id: {
    type: StringConstructor;
  };
  codeApprovalMode: {
    type: StringConstructor;
    enum: string[];
  };
  codeEnvironmentMode: {
    type: StringConstructor;
    enum: string[];
  };
  codeWorkspaces: {
    type: {
      environmentId: { type: StringConstructor; required: boolean };
      workspaceId: { type: StringConstructor; required: boolean };
      _id: boolean;
    }[];
    default: undefined;
  };
  /* assistants */
  assistant_id: {
    type: StringConstructor;
  };
  instructions: {
    type: StringConstructor;
  };
  stop: {
    type: {
      type: StringConstructor;
    }[];
    default: undefined;
  };
  isArchived: {
    type: BooleanConstructor;
    default: boolean;
  };
  /* UI Components */
  iconURL: {
    type: StringConstructor;
  };
  greeting: {
    type: StringConstructor;
  };
  spec: {
    type: StringConstructor;
  };
  tags: {
    type: StringConstructor[];
    default: never[];
  };
  tools: {
    type: {
      type: StringConstructor;
    }[];
    default: undefined;
  };
  maxContextTokens: {
    type: NumberConstructor;
  };
  max_tokens: {
    type: NumberConstructor;
  };
  useResponsesApi: {
    type: BooleanConstructor;
  };
  /** OpenAI Responses API / Anthropic API / Google API */
  web_search: {
    type: BooleanConstructor;
  };
  /** Google API: URL Context tool (+ native YouTube video understanding) */
  url_context: {
    type: BooleanConstructor;
  };
  disableStreaming: {
    type: BooleanConstructor;
  };
  fileTokenLimit: {
    type: NumberConstructor;
  };
  /** Reasoning models only */
  reasoning_effort: {
    type: StringConstructor;
  };
  reasoning_summary: {
    type: StringConstructor;
  };
  /** Responses API reasoning mode (standard/pro) + context */
  reasoning_mode: {
    type: StringConstructor;
  };
  reasoning_context: {
    type: StringConstructor;
  };
  /** Verbosity control */
  verbosity: {
    type: StringConstructor;
  };
} = {
  endpoint: {
    type: String,
    default: null,
    required: true,
  },
  endpointType: {
    type: String,
  },
  // for azureOpenAI, openAI only
  model: {
    type: String,
    required: false,
  },
  // for bedrock only
  region: {
    type: String,
    required: false,
  },
  // for azureOpenAI, openAI only
  chatGptLabel: {
    type: String,
    required: false,
  },
  // for google only
  examples: { type: [{ type: Schema.Types.Mixed }], default: undefined },
  modelLabel: {
    type: String,
    required: false,
  },
  promptPrefix: {
    type: String,
    required: false,
  },
  temperature: {
    type: Number,
    required: false,
  },
  top_p: {
    type: Number,
    required: false,
  },
  // for google only
  topP: {
    type: Number,
    required: false,
  },
  topK: {
    type: Number,
    required: false,
  },
  maxOutputTokens: {
    type: Number,
    required: false,
  },
  maxTokens: {
    type: Number,
    required: false,
  },
  presence_penalty: {
    type: Number,
    required: false,
  },
  frequency_penalty: {
    type: Number,
    required: false,
  },
  file_ids: { type: [{ type: String }], default: undefined },
  // deprecated
  resendImages: {
    type: Boolean,
  },
  /* Anthropic only */
  promptCache: {
    type: Boolean,
  },
  promptCacheTtl: {
    type: String,
  },
  thinking: {
    type: Boolean,
  },
  thinkingBudget: {
    type: Number,
  },
  thinkingLevel: {
    type: String,
  },
  effort: {
    type: String,
  },
  system: {
    type: String,
  },
  // files
  resendFiles: {
    type: Boolean,
  },
  imageDetail: {
    type: String,
  },
  /* agents */
  agent_id: {
    type: String,
  },
  codeApprovalMode: {
    type: String,
    enum: [...CODE_APPROVAL_MODES],
  },
  codeEnvironmentMode: {
    type: String,
    enum: [...CODE_ENVIRONMENT_MODES],
  },
  codeWorkspaces: {
    type: [
      {
        environmentId: { type: String, required: true },
        workspaceId: { type: String, required: true },
        _id: false,
      },
    ],
    default: undefined,
  },
  /* assistants */
  assistant_id: {
    type: String,
  },
  instructions: {
    type: String,
  },
  stop: { type: [{ type: String }], default: undefined },
  isArchived: {
    type: Boolean,
    default: false,
  },
  /* UI Components */
  iconURL: {
    type: String,
  },
  greeting: {
    type: String,
  },
  spec: {
    type: String,
  },
  tags: {
    type: [String],
    default: [],
  },
  tools: { type: [{ type: String }], default: undefined },
  maxContextTokens: {
    type: Number,
  },
  max_tokens: {
    type: Number,
  },
  useResponsesApi: {
    type: Boolean,
  },
  /** OpenAI Responses API / Anthropic API / Google API */
  web_search: {
    type: Boolean,
  },
  /** Google API: URL Context tool (+ native YouTube video understanding) */
  url_context: {
    type: Boolean,
  },
  disableStreaming: {
    type: Boolean,
  },
  fileTokenLimit: {
    type: Number,
  },
  /** Reasoning models only */
  reasoning_effort: {
    type: String,
  },
  reasoning_summary: {
    type: String,
  },
  /** Responses API reasoning mode (standard/pro) + context */
  reasoning_mode: {
    type: String,
  },
  reasoning_context: {
    type: String,
  },
  /** Verbosity control */
  verbosity: {
    type: String,
  },
};
