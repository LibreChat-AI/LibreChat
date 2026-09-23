import React from 'react';
import type { UIActionResult } from '@mcp-ui/client';
import type { TAskFunction } from '~/common';
import logger from './logger';

export * from './map';
export * from './policies';
export * from './json';
export * from './icons';
export * from './svg';
export * from './row';
export * from './email';
export * from './share';
export * from './files';
export * from './media';
export * from './greeting';
export * from './latex';
export * from './tilde';
export * from './morph';
export * from './forms';
export * from './roles';
export * from './errors';
export * from './agents';
export * from './drafts';
export * from './convos';
export * from './queue';
export * from './routes';
export * from './presets';
export * from './prompts';
export * from './voices';
export * from './textarea';
export * from './messages';
export * from './focus';
export * from './tokens';
export * from './redirect';
export * from './links';
export * from './languages';
export * from './conversation';
export * from './endpoints';
export * from './resources';
export * from './configHtml';
export * from './downloadFile';
export * from './scaleImage';
export * from './timestamps';
export * from './localStorage';
export * from './promptGroups';
export * from './previewCache';
export * from './groupToolCalls';
export * from './toolLabels';
export * from './favoritesError';
export * from './approval';
export * from './steer';
export * from './pane';
export * from './activityLabels';
export * from './agentModelSelection';
export * from './runStepDuration';
export * from './toolCallPhase';
export * from './documentTitle';
export * from './reasoningLabels';
export * from './numbers';
export { default as cn } from './cn';
export { default as logger } from './logger';
export { default as getLoginError } from './getLoginError';
export { default as cleanupPreset } from './cleanupPreset';
export { default as buildDefaultConvo } from './buildDefaultConvo';
export { default as getDefaultEndpoint } from './getDefaultEndpoint';
export { default as createChatSearchParams, processValidSettings } from './createChatSearchParams';
export { getThemeFromEnv } from './getThemeFromEnv';

export const languages = [
  'java',
  'c',
  'markdown',
  'css',
  'html',
  'xml',
  'bash',
  'json',
  'yaml',
  'jsx',
  'python',
  'c++',
  'javascript',
  'csharp',
  'php',
  'typescript',
  'swift',
  'objectivec',
  'sql',
  'r',
  'kotlin',
  'ruby',
  'go',
  'x86asm',
  'matlab',
  'perl',
  'pascal',
];

export const removeFocusOutlines = '';
export const removeFocusRings = 'focus:outline-hidden focus:ring-0 focus:ring-offset-0';

export const cardStyle =
  'transition-colors rounded-md min-w-[75px] border border-border-medium font-normal bg-surface-secondary hover:bg-surface-hover text-text-primary focus:outline-hidden data-[state=open]:bg-surface-hover';

export const defaultTextProps =
  'rounded-md border border-border-light focus:border-border-heavy focus:bg-surface-secondary bg-transparent text-sm text-text-primary shadow-[0_0_10px_rgba(0,0,0,0.05)] outline-hidden focus-within:placeholder:text-text-primary focus:placeholder:text-text-primary placeholder:text-text-secondary focus:outline-hidden focus:ring-text-primary/20 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export const optionText =
  'p-0 shadow-none text-right pr-1 h-8 border-transparent hover:bg-surface-hover transition-colors';

export const defaultTextPropsLabel =
  'rounded-md border border-border-medium bg-transparent text-sm text-text-primary shadow-[0_0_10px_rgba(0,0,0,0.10)] outline-hidden focus-within:placeholder:text-text-primary focus:placeholder:text-text-primary placeholder:text-text-secondary focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50';

export function capitalizeFirstLetter(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

export const handleDoubleClick: React.MouseEventHandler<HTMLElement> = (event) => {
  const range = document.createRange();
  range.selectNodeContents(event.target as Node);
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
};

export const extractContent = (
  children: React.ReactNode | { props: { children: React.ReactNode } } | string,
): string => {
  if (typeof children === 'string') {
    return children;
  }
  if (React.isValidElement(children)) {
    return extractContent((children.props as { children?: React.ReactNode }).children);
  }
  if (Array.isArray(children)) {
    return children.map(extractContent).join('');
  }
  return '';
};

/** Converts supported legacy MCP-UI actions into the existing conversation submission path. */
export const handleUIAction = async (result: UIActionResult, ask: TAskFunction) => {
  const { type, payload } = result;
  let messageText = '';

  if (type === 'intent') {
    const { intent, params } = payload;
    messageText = `The user clicked a button in an embedded UI Resource, and we got a message of type \`intent\`.
The intent is \`${intent}\` and the params are:

\`\`\`json
${JSON.stringify(params, null, 2)}
\`\`\`

Execute the intent that is mentioned in the message using the tools available to you.
    `;
  } else if (type === 'tool') {
    const { toolName, params } = payload;
    messageText = `The user clicked a button in an embedded UI Resource, and we got a message of type \`tool\`.
The tool name is \`${toolName}\` and the params are:

\`\`\`json
${JSON.stringify(params, null, 2)}
\`\`\`

Execute the tool that is mentioned in the message using the tools available to you.
    `;
  } else if (type === 'prompt') {
    const { prompt } = payload;
    messageText = `The user clicked a button in an embedded UI Resource, and we got a message of type \`prompt\`.
The prompt is:

\`\`\`
${prompt}
\`\`\`

Execute the intention of the prompt that is mentioned in the message using the tools available to you.
    `;
  } else {
    return;
  }

  logger.debug('MCP-UI', 'About to submit message:', messageText);
  ask({ text: messageText });
  logger.debug('MCP-UI', 'Message submitted successfully');
};
