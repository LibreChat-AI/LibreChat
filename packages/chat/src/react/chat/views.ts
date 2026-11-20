import { toUIMessage } from 'librechat-data-provider';
import type { TMessage, UIMessage, TAttachment } from 'librechat-data-provider';
import type { ChatViewContract } from './contract';

/**
 * Every message field a view is built from, identity and metadata included: a stream frame or a
 * new chat's promotion can replace these on the same object.
 */
const viewSourceKeys = [
  'messageId',
  'isCreatedByUser',
  'conversationId',
  'parentMessageId',
  'content',
  'text',
  'files',
  'attachments',
  'error',
  'unfinished',
  'sender',
  'model',
  'endpoint',
  'createdAt',
] as const;

type CachedView = {
  view: UIMessage;
  source: Pick<TMessage, (typeof viewSourceKeys)[number]>;
  live: TAttachment[] | undefined;
  getMappingOptions: ChatViewContract['getMappingOptions'];
};

const views = new WeakMap<TMessage, CachedView>();

const isSameSource = (
  cached: CachedView,
  message: TMessage,
  live: TAttachment[] | undefined,
  getMappingOptions: ChatViewContract['getMappingOptions'],
) =>
  cached.live === live &&
  cached.getMappingOptions === getMappingOptions &&
  viewSourceKeys.every((key) => cached.source[key] === message[key]);

/**
 * Cached per message, per snapshot of the fields a view reads and per live attachment list: a
 * stream frame that replaces a response's content, or an attachment that arrives for it, remaps
 * that response, while untouched messages keep their views. A host with other tool outcome rules
 * maps its own view.
 */
export const toView = (
  message: TMessage,
  live: TAttachment[] | undefined,
  getMappingOptions: ChatViewContract['getMappingOptions'],
): UIMessage => {
  const cached = views.get(message);
  if (cached && isSameSource(cached, message, live, getMappingOptions)) {
    return cached.view;
  }
  const view = toUIMessage(message, getMappingOptions(live));
  const source = {} as CachedView['source'];
  for (const key of viewSourceKeys) {
    Object.assign(source, { [key]: message[key] });
  }
  views.set(message, { view, source, live, getMappingOptions });
  return view;
};
