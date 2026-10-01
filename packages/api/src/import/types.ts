import { Tools, ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type {
  TImportJob,
  TImportPhase,
  TImportReport,
  TImportCounter,
  TImportSummary,
  TImportProgress,
  SearchResultData,
  TImportJobStatus,
} from 'librechat-data-provider';

export interface ImportedAsset {
  file_id: string;
  filepath: string;
  filename: string;
  type: string;
  width?: number;
  height?: number;
}

export interface ChatGptAuthor {
  role: 'user' | 'assistant' | 'system' | 'tool';
  name: string | null;
}

export interface ChatGptImagePointer {
  content_type: 'image_asset_pointer';
  asset_pointer: string;
  width?: number;
  height?: number;
  size_bytes?: number;
}

export interface ChatGptAudioPointer {
  content_type: 'audio_asset_pointer';
  asset_pointer: string;
  format?: string;
  size_bytes?: number;
}

export interface ChatGptAudioTranscription {
  content_type: 'audio_transcription';
  text: string;
  direction: 'in' | 'out' | null;
}

export interface ChatGptRealtimePointer {
  content_type: 'real_time_user_audio_video_asset_pointer';
  audio_asset_pointer: ChatGptAudioPointer | null;
}

export type ChatGptPart =
  | string
  | ChatGptImagePointer
  | ChatGptAudioPointer
  | ChatGptAudioTranscription
  | ChatGptRealtimePointer;

export interface ChatGptThought {
  content: string | null;
  summary: string | null;
}

export interface ChatGptContent {
  content_type: string;
  parts?: ChatGptPart[];
  text?: string;
  language?: string;
  content?: string;
  /** Payload of a `tether_browsing_display` block, which carries no `parts`. */
  result?: string;
  thoughts?: ChatGptThought[];
  source_analysis_msg_id?: string;
}

export interface ChatGptSearchEntry {
  title: string | null;
  url: string | null;
  snippet: string | null;
  attributions: string | null;
}

export interface ChatGptSearchGroup {
  domain: string | null;
  entries: ChatGptSearchEntry[];
}

export interface ChatGptContentReference {
  type: string;
  alt: string | null;
  url?: string | null;
  title?: string | null;
  snippet?: string | null;
  attribution?: string | null;
  pub_date?: number | null;
  items?: ChatGptSearchEntry[];
  sources?: ChatGptSearchEntry[];
  name?: string | null;
  id?: string | null;
}

export interface ChatGptAttachment {
  id: string;
  name?: string;
  mime_type?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface ChatGptLegacyCitationMetadata {
  type?: string | null;
  title?: string | null;
  url?: string | null;
  text?: string | null;
  pub_date?: number | null;
}

export interface ChatGptLegacyCitation {
  start_ix?: number | null;
  end_ix?: number | null;
  citation_format_type?: string | null;
  metadata?: ChatGptLegacyCitationMetadata | null;
}

export interface ChatGptMessageMetadata {
  model_slug?: string;
  attachments?: ChatGptAttachment[];
  content_references?: ChatGptContentReference[];
  search_result_groups?: ChatGptSearchGroup[];
  image_results?: ChatGptSearchEntry[];
  citations?: ChatGptLegacyCitation[];
}

export interface ChatGptMessage {
  id: string;
  author: ChatGptAuthor;
  create_time: number | null;
  content: ChatGptContent;
  metadata?: ChatGptMessageMetadata;
}

export interface ChatGptNode {
  id: string;
  message: ChatGptMessage | null;
  parent: string | null;
  children: string[];
}

export interface ChatGptConversation {
  conversation_id: string;
  title: string | null;
  create_time: number | null;
  update_time: number | null;
  default_model_slug: string | null;
  is_archived: boolean | null;
  is_starred: boolean | null;
  pinned_time: string | null;
  mapping: Record<string, ChatGptNode>;
}

/** Every content block a Claude export puts on a message, flattened into one
 * optional-field shape (mirroring `ChatGptContent`) because the block union is
 * open: `token_budget` and any future type must fall through the converter
 * untouched rather than fail to narrow. */
export interface ClaudeContentBlock {
  type: string;
  text?: string | null;
  citations?: ClaudeCitation[] | null;
  thinking?: string | null;
  summaries?: ClaudeThinkingSummary[] | null;
  name?: string | null;
  id?: string | null;
  input?: object | null;
  tool_use_id?: string | null;
  content?: ClaudeResultBlock[] | null;
  is_error?: boolean | null;
}

/** One entry inside a `tool_result`'s `content` array. `knowledge` carries a
 * real web source; `image`, `image_gallery` and `local_resource` reference
 * bytes the export does not ship. */
export interface ClaudeResultBlock {
  type: string;
  text?: string | null;
  title?: string | null;
  url?: string | null;
  name?: string | null;
  file_path?: string | null;
}

export interface ClaudeCitationDetails {
  type: string;
  url?: string | null;
}

export interface ClaudeCitation {
  uuid?: string | null;
  start_index: number;
  end_index: number;
  details?: ClaudeCitationDetails | null;
}

export interface ClaudeThinkingSummary {
  summary?: string | null;
}

/** A file the user attached whose text Claude extracted inline. The export
 * ships no binaries, so `extracted_content` is the only recoverable content. */
export interface ClaudeAttachment {
  file_name?: string | null;
  file_type?: string | null;
  file_size?: number | null;
  extracted_content?: string | null;
}

export interface ClaudeFileReference {
  file_uuid?: string | null;
  file_name?: string | null;
}

export interface ClaudeMessage {
  uuid: string;
  sender: string;
  text?: string | null;
  content?: ClaudeContentBlock[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  parent_message_uuid?: string | null;
  attachments?: ClaudeAttachment[] | null;
  files?: ClaudeFileReference[] | null;
}

export interface ClaudeConversation {
  uuid: string;
  name?: string | null;
  summary?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  chat_messages?: ClaudeMessage[] | null;
}

/** A timestamp in either shape a Grok export writes. Conversations carry an
 * ISO string; every response carries MongoDB Extended JSON, canonical
 * (`{ $date: { $numberLong: '1783999510820' } }`) in the exports measured so
 * far and relaxed (`{ $date: '2026-07-14T03:25:09Z' }`) by specification. */
export type GrokTimestamp =
  | string
  | number
  | { $date?: string | number | { $numberLong?: string | number | null } | null }
  | null;

/** One turn of a Grok conversation. `message` is plain text in every response
 * of a real export (Grok ships no content blocks), while the reasoning,
 * search and attachment fields it can carry alongside are out of scope. */
export interface GrokResponse {
  _id: string;
  message: string;
  sender: string;
  model?: string | null;
  create_time?: GrokTimestamp;
  parent_response_id?: string | null;
}

export interface GrokConversationMeta {
  id: string;
  title?: string | null;
  summary?: string | null;
  starred?: boolean | null;
  create_time?: GrokTimestamp;
}

/** Grok wraps every response in a one-key envelope carrying an optional
 * `share_link` beside it. */
export interface GrokResponseEntry {
  response: GrokResponse;
}

export interface GrokConversationEntry {
  conversation: GrokConversationMeta;
  responses?: GrokResponseEntry[] | null;
}

/** The root object of `prod-grok-backend.json`. `projects`, `tasks` and
 * `media_posts` sit beside `conversations` and are out of scope, so they are
 * deliberately absent from this type rather than parsed and ignored. */
export interface GrokExport {
  conversations: unknown[];
}

export interface ImportAttachment {
  type: Tools.web_search;
  [Tools.web_search]: SearchResultData;
}

export interface ImageFilePart {
  type: ContentTypes.IMAGE_FILE;
  [ContentTypes.IMAGE_FILE]: ImportedAsset;
}

/** The tool call shape `Part.tsx` renders. `progress` must be 1: every tool
 * card reads `toolCall.progress ?? 0.1` and an imported call is finished, so
 * anything lower renders as perpetually running. */
export interface ToolCallPart {
  type: ContentTypes.TOOL_CALL;
  [ContentTypes.TOOL_CALL]: {
    name: string;
    args: string;
    id?: string;
    output?: string;
    progress: number;
    type: ToolCallTypes.TOOL_CALL;
  };
}

export type ConvertedContentPart =
  | { type: 'think'; think: string }
  | { type: 'text'; text: string }
  | ImageFilePart
  | ToolCallPart;

export interface ConvertedMessage {
  messageId: string;
  parentMessageId: string;
  text: string;
  sender: string;
  isCreatedByUser: boolean;
  model: string;
  createdAt: Date;
  content?: ConvertedContentPart[];
  attachments?: ImportAttachment[];
  files?: ImportedAsset[];
  assetPointers: string[];
}

export interface ConvertedConversation {
  conversationId: string;
  externalId: string;
  title: string;
  createdAt: Date;
  isArchived: boolean;
  pinned: boolean;
  model: string;
  messages: ConvertedMessage[];
}

/** Which converter an export's conversations belong to. ChatGPT and Claude
 * both ship a `conversations.json` array and Grok ships an object keyed by
 * `conversations`, so this is resolved from the parsed shape rather than the
 * archive layout. */
export type ExportFormat = 'chatgpt' | 'claude' | 'grok';

/**
 * The job vocabulary is declared once, in `librechat-data-provider`, and
 * aliased here. It is the contract between this package and the client, and
 * the route that serves it (`GET /import/jobs/:jobId`) is untyped JS, so two
 * hand-maintained copies could drift silently, and the first symptom would be
 * a client that polls a phase it does not recognise forever.
 */
export type ImportPhase = TImportPhase;
export type ImportCounter = TImportCounter;
export type ImportProgress = TImportProgress;
export type ImportSummary = TImportSummary;
export type ImportReport = TImportReport;
export type ImportJobStatus = TImportJobStatus;

/** The stored job: what the client sees, plus the two fields the route strips
 * before responding. Deriving it this way is what makes that strip provably
 * exhaustive rather than a comment. */
export type ImportJob = TImportJob & {
  userId: string;
  filepath: string;
};

export interface ImportedCitations {
  turn: number;
  data: SearchResultData;
}
