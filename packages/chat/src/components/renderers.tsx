import type { ReactNode } from 'react';
import type { MessagePartsImageProps, MessagePartsMarkdownProps } from '../react/host';
import MarkdownLite from './markdown/Lite';
import Markdown from './markdown/Markdown';
import Image from './parts/Image';

/** How a part draws markdown when the host names no renderer: the package's own two. */
export function renderMarkdown({
  content,
  variant,
  isLatestMessage,
  codeExecution,
}: MessagePartsMarkdownProps): ReactNode {
  return variant === 'lite' ? (
    <MarkdownLite content={content} codeExecution={codeExecution} />
  ) : (
    <Markdown content={content} isLatestMessage={isLatestMessage} />
  );
}

/** How a part draws an attached image when the host names no renderer: the package's card. */
export function renderImage(props: MessagePartsImageProps): ReactNode {
  return <Image {...props} />;
}
