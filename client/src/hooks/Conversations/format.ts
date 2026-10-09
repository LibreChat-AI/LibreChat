import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';

import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
import { getActivityLabelPart, getActivityLabelText } from '~/utils/activityLabels';

export type ExportFormat = 'text' | 'md';
export type MessageContentExport = [] | [sender: string, text: string];

type TextValue = string | { value?: string | null } | null | undefined;
type TextDeltaContentPart = {
  type: ContentTypes.TEXT_DELTA;
  text?: TextValue;
  text_delta?: TextValue;
};
type SummaryContentPart = Extract<TMessageContentParts, { type: ContentTypes.SUMMARY }>;
type ExportSummaryContentPart = Omit<SummaryContentPart, 'content'> & {
  content?: Array<{ type: ContentTypes.TEXT; text?: TextValue }> | string;
  text?: TextValue;
};

export type ExportableContentPart =
  | Exclude<TMessageContentParts, SummaryContentPart>
  | ExportSummaryContentPart
  | TextDeltaContentPart;

export const handledExportContentTypes = [
  ContentTypes.TEXT,
  ContentTypes.THINK,
  ContentTypes.TEXT_DELTA,
  ContentTypes.TOOL_CALL,
  ContentTypes.IMAGE_FILE,
  ContentTypes.IMAGE_URL,
  ContentTypes.VIDEO_URL,
  ContentTypes.INPUT_AUDIO,
  ContentTypes.AGENT_UPDATE,
  ContentTypes.SUMMARY,
  ContentTypes.STEER,
  ContentTypes.ACTIVITY_LABEL,
  ContentTypes.ERROR,
] satisfies readonly ContentTypes[];

const getTextValue = (value: TextValue): string => {
  if (typeof value === 'string') {
    return value;
  }
  return value?.value ?? '';
};

const stringify = (value: unknown): string => JSON.stringify(value ?? null);

const hasFormattedContent = (content: MessageContentExport): content is [string, string] =>
  content.length > 0;

const exportLabelKeys = {
  tool: 'com_ui_export_tool',
  image: 'com_ui_export_image',
  audio: 'com_ui_export_audio',
  video: 'com_ui_export_video',
  summary: 'com_ui_export_summary',
  steer: 'com_ui_export_steer',
  retrieval: 'com_ui_export_retrieval',
  fileSearch: 'com_ui_export_file_search',
  agentUpdate: 'com_ui_export_agent_update',
  activityLabel: 'com_ui_export_activity_label',
} satisfies Record<string, Parameters<LocalizeFunction>[0]>;

const stripThinkTags = (reasoning: string): string =>
  reasoning
    .replace(/^<think>\s*/, '')
    .replace(/\s*<\/think>$/, '')
    .trim();

const formatReasoning = ({
  reasoning,
  format,
  localize,
}: {
  reasoning: string;
  format: ExportFormat;
  localize: LocalizeFunction;
}): string => {
  const label = localize('com_endpoint_thinking');
  if (format === 'md') {
    return `<details>\n<summary>${label}</summary>\n\n${reasoning}\n</details>`;
  }
  return `${label}:\n${reasoning}`;
};

const getUrlText = (value: string | { url?: string } | undefined): string => {
  if (typeof value === 'string') {
    return value;
  }
  return value?.url ?? stringify(value);
};

const getSummaryText = (content: ExportSummaryContentPart): string | undefined => {
  if (Array.isArray(content.content)) {
    return content.content.map((part) => getTextValue(part.text)).join('');
  }
  if (typeof content.content === 'string') {
    return content.content;
  }
  const text = getTextValue(content.text);
  if (text.length > 0) {
    return text;
  }
  return undefined;
};

export function formatMessageContent({
  sender,
  content,
  format = 'text',
  localize,
}: {
  sender: string;
  content?: ExportableContentPart;
  format?: ExportFormat;
  localize: LocalizeFunction;
}): MessageContentExport {
  if (!content) {
    return [];
  }

  if (content.type === ContentTypes.ERROR) {
    return [sender, content.error ?? getTextValue(content.text)];
  }

  if (content.type === ContentTypes.TEXT) {
    const text = getTextValue(content.text);
    if (text.trim().length === 0) {
      return [];
    }
    return [sender, text];
  }

  if (content.type === ContentTypes.THINK) {
    const reasoning = stripThinkTags(getTextValue(content.think));
    if (reasoning.trim().length === 0) {
      return [];
    }
    return [sender, formatReasoning({ reasoning, format, localize })];
  }

  if (content.type === ContentTypes.TEXT_DELTA) {
    const text = getTextValue(content.text_delta ?? content.text);
    if (text.trim().length === 0) {
      return [];
    }
    return [sender, text];
  }

  if (content.type === ContentTypes.TOOL_CALL) {
    const toolCall = content.tool_call;
    if (!toolCall) {
      return [localize(exportLabelKeys.tool), stringify(toolCall)];
    }
    if (toolCall.type === ToolCallTypes.CODE_INTERPRETER) {
      return [localize('com_ui_run_code'), stringify(toolCall.code_interpreter)];
    }
    if (toolCall.type === ToolCallTypes.RETRIEVAL) {
      return [localize(exportLabelKeys.retrieval), stringify(toolCall)];
    }
    if (toolCall.type === ToolCallTypes.FILE_SEARCH) {
      return [localize(exportLabelKeys.fileSearch), stringify(toolCall)];
    }
    return [localize(exportLabelKeys.tool), stringify(toolCall)];
  }

  if (content.type === ContentTypes.IMAGE_FILE) {
    return [localize(exportLabelKeys.image), stringify(content.image_file)];
  }

  if (content.type === ContentTypes.IMAGE_URL) {
    return [localize(exportLabelKeys.image), getUrlText(content.image_url)];
  }

  if (content.type === ContentTypes.VIDEO_URL) {
    return [localize(exportLabelKeys.video), getUrlText(content.video_url)];
  }

  if (content.type === ContentTypes.INPUT_AUDIO) {
    return [localize(exportLabelKeys.audio), stringify(content.input_audio)];
  }

  if (content.type === ContentTypes.AGENT_UPDATE) {
    return [localize(exportLabelKeys.agentUpdate), stringify(content.agent_update)];
  }

  if (content.type === ContentTypes.SUMMARY) {
    const summary = getSummaryText(content);
    return [localize(exportLabelKeys.summary), summary ?? stringify(content)];
  }

  if (content.type === ContentTypes.STEER) {
    const text = content.steer ?? '';
    if (text.trim().length === 0) {
      return [];
    }
    return [localize(exportLabelKeys.steer), text];
  }

  if (content.type === ContentTypes.ACTIVITY_LABEL) {
    const text = getActivityLabelText(getActivityLabelPart(content as TMessageContentParts));
    if (text.trim().length === 0) {
      return [];
    }
    return [localize(exportLabelKeys.activityLabel), text];
  }

  return [sender, stringify(content)];
}

export function formatMessageText({
  message,
  format = 'text',
  localize,
}: {
  message: Partial<TMessage> | undefined;
  format?: ExportFormat;
  localize: LocalizeFunction;
}): string {
  if (!message) {
    return '';
  }

  const formatText = (sender: string, text: string) => {
    if (format === 'text') {
      return `>> ${sender}:\n${text}`;
    }
    return `**${sender}**\n${text}`;
  };

  if (!message.content) {
    return formatText(message.sender || '', message.text || '');
  }

  return message.content
    .filter((content) => content != null)
    .map((content) =>
      formatMessageContent({
        sender: message.sender || '',
        content,
        format,
        localize,
      }),
    )
    .filter(hasFormattedContent)
    .map((text) => formatText(text[0], text[1]))
    .join('\n\n\n');
}
