import type { TextContentFragment } from './types';

const LEGACY_STORED_MESSAGE_FIELDS = new Set([
  'text',
  'quote',
  'answer',
  'decision_response',
  'decision_reason',
  'content_part',
]);

export function isLegacyPiiFragment(fragment: TextContentFragment): boolean {
  if (fragment.source === 'assembled_context') {
    return (
      fragment.id === 'chat.assembled.quote-text' ||
      fragment.id === 'stored-message.assembled' ||
      fragment.id === 'stored-message.user-submitted-assembled'
    );
  }
  if (fragment.source === 'tool_argument') {
    return /^chat\.decision\.\d+\.arguments$/.test(fragment.id);
  }
  if (fragment.source !== 'message') {
    return false;
  }
  if (fragment.id.startsWith('stored-message.')) {
    return LEGACY_STORED_MESSAGE_FIELDS.has(fragment.field);
  }
  return (
    fragment.id === 'chat.text' ||
    fragment.id === 'chat.input' ||
    fragment.id === 'chat.answer' ||
    /^chat\.quote\.\d+$/.test(fragment.id) ||
    /^chat\.decision\.\d+\.(?:response|reason)$/.test(fragment.id) ||
    /^external-message\.\d+\.(?:content|part\.\d+)$/.test(fragment.id)
  );
}
