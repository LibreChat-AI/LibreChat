/* The chat package's renderer draws its own markdown elements; this app's code block and diagram
 * reach them through the slots `./MarkdownComponents` registers. */
import './MarkdownComponents';

export { MarkdownLite as default } from '@librechat/chat/components';
