import type {
  FileFilterField,
  SkillFilterField,
  MemoryFilterField,
  PromptFilterField,
  MessageFilterField,
  FeedbackFilterField,
  ToolArgumentFilterField,
  ModelParameterFilterField,
  ActionMetadataFilterField,
  AgentInstructionFilterField,
  ConversationTitleFilterField,
  ConversationStarterFilterField,
} from 'librechat-data-provider';

export type ContentSource =
  | 'message'
  | 'prompt'
  | 'agent_instruction'
  | 'conversation_starter'
  | 'skill'
  | 'memory'
  | 'file'
  | 'tool_argument'
  | 'model_parameter'
  | 'action_metadata'
  | 'feedback'
  | 'conversation_title'
  | 'assembled_context';

export type ContentProvenance =
  | 'user'
  | 'administrator'
  | 'model'
  | 'tool'
  | 'retrieval'
  | 'system'
  | 'external_agent';

export type ContentFormat = 'plain' | 'markdown' | 'json' | 'uri';
export type ContentTreatment = 'replaceable' | 'inspect_only';
export type JsonPointer = `/${string}`;

export interface ContentFieldMap {
  message: MessageFilterField;
  prompt: PromptFilterField;
  agent_instruction: AgentInstructionFilterField;
  conversation_starter: ConversationStarterFilterField;
  skill: SkillFilterField;
  memory: MemoryFilterField;
  file: FileFilterField;
  tool_argument: ToolArgumentFilterField;
  model_parameter: ModelParameterFilterField;
  action_metadata: ActionMetadataFilterField;
  feedback: FeedbackFilterField;
  conversation_title: ConversationTitleFilterField;
  assembled_context: MessageFilterField;
}

interface TextContentFragmentBase {
  readonly id: string;
  readonly provenance: ContentProvenance;
  readonly path: JsonPointer;
  readonly format: ContentFormat;
  readonly treatment: ContentTreatment;
  readonly text: string;
}

export type TextContentFragment = {
  [Source in ContentSource]: TextContentFragmentBase & {
    readonly source: Source;
    readonly field: ContentFieldMap[Source];
  };
}[ContentSource];

export interface ProtectionFinding {
  readonly detectorId: string;
  readonly ruleId: string;
  readonly label: string;
  readonly source: ContentSource;
  readonly field: ContentFieldMap[ContentSource];
  readonly provenance: ContentProvenance;
  readonly fragmentId: string;
  readonly fragmentPath: JsonPointer;
}
