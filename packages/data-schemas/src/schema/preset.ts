import { Schema, Document } from 'mongoose';
import { conversationPreset } from './defaults';

// @ts-ignore
export interface IPreset extends Document {
  presetId: string;
  title: string;
  user: string | null;
  defaultPreset?: boolean;
  order?: number;
  // Additional fields from conversationPreset and others will be available via an index signature.
  endpoint?: string;
  endpointType?: string;
  model?: string;
  region?: string;
  chatGptLabel?: string;
  examples?: unknown[];
  modelLabel?: string;
  promptPrefix?: string;
  temperature?: number;
  top_p?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  maxTokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  file_ids?: string[];
  resendImages?: boolean;
  promptCache?: boolean;
  promptCacheTtl?: '5m' | '1h';
  thinking?: boolean;
  thinkingBudget?: number;
  effort?: string;
  system?: string;
  resendFiles?: boolean;
  imageDetail?: string;
  agent_id?: string;
  assistant_id?: string;
  instructions?: string;
  stop?: string[];
  isArchived?: boolean;
  iconURL?: string;
  greeting?: string;
  spec?: string;
  tags?: string[];
  tools?: string[];
  maxContextTokens?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  reasoning_summary?: string;
  reasoning_mode?: string;
  reasoning_context?: string;
  verbosity?: string;
  useResponsesApi?: boolean;
  web_search?: boolean;
  url_context?: boolean;
  disableStreaming?: boolean;
  fileTokenLimit?: number;
  tenantId?: string;
}

const presetSchema: Schema<IPreset> = new Schema(
  {
    presetId: {
      type: String,
      required: true,
      index: true,
    },
    title: {
      type: String,
      default: 'New Chat',
      meiliIndex: true,
    },
    user: {
      type: String,
      default: null,
    },
    defaultPreset: {
      type: Boolean,
    },
    order: {
      type: Number,
    },
    ...conversationPreset,
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

presetSchema.index({ presetId: 1, tenantId: 1 }, { unique: true });

export default presetSchema;
