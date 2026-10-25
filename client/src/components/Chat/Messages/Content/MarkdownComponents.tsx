import React, { memo, useMemo, useRef, useEffect } from 'react';
import { PermissionTypes, Permissions, apiBaseUrl } from 'librechat-data-provider';
import type { Element, ElementContent } from 'hast';
import {
  handleDoubleClick,
  triggerDownload,
  resolveInlineMedia,
  toAbsoluteFilePath,
} from '~/utils';
import Mermaid, { MermaidErrorBoundary } from '~/components/Messages/Content/Mermaid';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import { useCodeBlockContext, useMediaContext } from '~/Providers';
import CodeBlock from '~/components/Messages/Content/CodeBlock';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import { strongDirection } from '~/utils/direction';
import { useFileDownload } from '~/data-provider';
import { useLocalize } from '~/hooks';

type TCodeProps = {
  inline?: boolean;
  className?: string;
  children: React.ReactNode;
};

const isSingleLineCode = (children: React.ReactNode): boolean => {
  if (typeof children === 'string') {
    return !children.includes('\n');
  }
  if (Array.isArray(children)) {
    return children.every((child) => typeof child === 'string' && !child.includes('\n'));
  }
  return false;
};

export const code: React.ElementType = memo(function MarkdownCode({
  className,
  children,
}: TCodeProps) {
  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });
  const match = /language-(\w+)/.exec(className ?? '');
  const lang = match && match[1];
  const isMath = lang === 'math';
  const isMermaid = lang === 'mermaid';
  const isSingleLine = isSingleLineCode(children);

  const { getNextIndex, getNextMermaidIndex, resetCounter } = useCodeBlockContext();
  const blockIndex = useRef(getNextIndex(isMath || isMermaid || isSingleLine)).current;
  /* Mermaid fences do not consume a code-block index, so every one of them in a
   * message would otherwise share `blockIndex` and collapse onto a single
   * artifact id. They carry their own sequence instead. */
  const mermaidIndex = useRef(isMermaid ? getNextMermaidIndex() : -1).current;

  useEffect(() => {
    resetCounter();
  }, [children, resetCounter]);

  if (isMath) {
    return <>{children}</>;
  } else if (isMermaid) {
    const content = typeof children === 'string' ? children : String(children);
    return (
      <MermaidErrorBoundary code={content}>
        <Mermaid id={`mermaid-${mermaidIndex}`}>{content}</Mermaid>
      </MermaidErrorBoundary>
    );
  } else if (isSingleLine) {
    return (
      <code onDoubleClick={handleDoubleClick} className={className}>
        {children}
      </code>
    );
  } else {
    return (
      <CodeBlock
        lang={lang ?? 'text'}
        codeChildren={children}
        blockIndex={blockIndex}
        allowExecution={canRunCode}
      />
    );
  }
});
code.displayName = 'MarkdownCode';

export const codeNoExecution: React.ElementType = memo(function MarkdownCodeNoExecution({
  className,
  children,
}: TCodeProps) {
  const match = /language-(\w+)/.exec(className ?? '');
  const lang = match && match[1];

  if (lang === 'math') {
    return children;
  } else if (lang === 'mermaid') {
    const content = typeof children === 'string' ? children : String(children);
    return <Mermaid>{content}</Mermaid>;
  } else if (isSingleLineCode(children)) {
    return (
      <code onDoubleClick={handleDoubleClick} className={className}>
        {children}
      </code>
    );
  } else {
    return <CodeBlock lang={lang ?? 'text'} codeChildren={children} allowExecution={false} />;
  }
});
codeNoExecution.displayName = 'MarkdownCodeNoExecution';

type TAnchorProps = {
  href: string;
  children: React.ReactNode;
};

export const a: React.ElementType = memo(function MarkdownAnchor({ href, children }: TAnchorProps) {
  const { useUser, useToast } = useMessagePartsHost();
  const user = useUser();
  const showToast = useToast();
  const localize = useLocalize();

  const {
    file_id = '',
    filename = '',
    filepath,
  } = useMemo(() => {
    const pattern = new RegExp(`(?:files|outputs)/${user?.id}/([^\\s]+)`);
    const match = href.match(pattern);
    if (match && match[0]) {
      const path = match[0];
      const parts = path.split('/');
      const name = parts.pop();
      const file_id = parts.pop();
      return { file_id, filename: name, filepath: path };
    }
    return { file_id: '', filename: '', filepath: '' };
  }, [user?.id, href]);

  const { refetch: downloadFile } = useFileDownload(user?.id ?? '', file_id, { direct: false });
  const props: { target?: string; onClick?: React.MouseEventHandler } = { target: '_blank' };

  if (!file_id || !filename) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }

  const handleDownload = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    try {
      const stream = await downloadFile();
      if (stream.data == null || stream.data === '') {
        console.error('Error downloading file: No data found');
        showToast({
          status: 'error',
          message: localize('com_ui_download_error'),
        });
        return;
      }
      triggerDownload(stream.data, filename);
    } catch (error) {
      console.error('Error downloading file:', error);
    }
  };

  props.onClick = handleDownload;
  props.target = '_blank';

  const domainServerBaseUrl = `${apiBaseUrl()}/api`;

  return (
    <a
      href={
        filepath?.startsWith('files/')
          ? `${domainServerBaseUrl}/${filepath}`
          : `${domainServerBaseUrl}/files/${filepath}`
      }
      {...props}
    >
      {children}
    </a>
  );
});
a.displayName = 'MarkdownAnchor';

type TParagraphProps = {
  children: React.ReactNode;
};

export const p: React.ElementType = memo(function MarkdownParagraph({ children }: TParagraphProps) {
  return (
    <p dir="auto" className="mb-2 whitespace-pre-wrap">
      {children}
    </p>
  );
});
p.displayName = 'MarkdownParagraph';

type TBlockProps = React.HTMLAttributes<HTMLElement> & { node?: Element };

/** Resolves direction per block so a mixed-language reply is not laid out by its first character. */
const withAutoDir = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => {
  const Block: React.ElementType = memo(function MarkdownBlock({
    node: _node,
    ...props
  }: TBlockProps) {
    return <Tag dir="auto" {...props} />;
  });
  Block.displayName = `Markdown${Tag.toUpperCase()}`;
  return Block;
};

/** First strong direction of a subtree's text, skipping code, which is always left-to-right. */
const nodeDirection = (node: Element | ElementContent): 'ltr' | 'rtl' | null => {
  if (node.type === 'text') {
    return strongDirection(node.value);
  }
  if (node.type !== 'element' || node.tagName === 'code' || node.tagName === 'pre') {
    return null;
  }
  for (const child of node.children) {
    const direction = nodeDirection(child);
    if (direction != null) {
      return direction;
    }
  }
  return null;
};

/**
 * Quotes and lists hold paragraphs that carry their own `dir="auto"`, and the browser's
 * `dir="auto"` skips those, so a container would resolve to LTR whatever its text. Resolve it
 * from the subtree instead, and inherit when there is no strong character. A list takes one
 * direction so its markers and indent stay on the same side.
 */
const withContentDir = (Tag: 'ul' | 'ol' | 'blockquote') => {
  const Block: React.ElementType = memo(function MarkdownContainer({
    node,
    ...props
  }: TBlockProps) {
    const dir = node != null ? (nodeDirection(node) ?? undefined) : undefined;
    return <Tag dir={dir} {...props} />;
  });
  Block.displayName = `Markdown${Tag.toUpperCase()}`;
  return Block;
};

export const ul = withContentDir('ul');
export const ol = withContentDir('ol');
export const h1 = withAutoDir('h1');
export const h2 = withAutoDir('h2');
export const h3 = withAutoDir('h3');
export const h4 = withAutoDir('h4');
export const h5 = withAutoDir('h5');
export const h6 = withAutoDir('h6');
export const blockquote = withContentDir('blockquote');

type TTableProps = {
  children: React.ReactNode;
  node?: Element;
};

/** One direction for the whole table, so cell borders and corners stay on a single frame. */
export const table: React.ElementType = memo(function MarkdownTable({
  children,
  node,
}: TTableProps) {
  const dir = node != null ? (nodeDirection(node) ?? undefined) : undefined;
  return (
    <div dir={dir} className="markdown-table-wrapper w-full max-w-full">
      <table>{children}</table>
    </div>
  );
});
table.displayName = 'MarkdownTable';

type TImageProps = {
  src?: string;
  alt?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
};

export const img: React.ElementType = memo(function MarkdownImage({
  src,
  alt,
  title,
  className,
  style,
}: TImageProps) {
  // Get the base URL from the API endpoints
  const baseURL = apiBaseUrl();
  /** A model writing `![DTI](5_dti.png)` is naming a file its run produced,
   *  not a path the browser can fetch. Resolving the reference against the
   *  turn's attachments is what turns those into the chart instead of a
   *  broken-image glyph; an unmatched source keeps its original behavior. */
  const { attachmentsByName } = useMediaContext();

  const fixedSrc = useMemo(() => {
    if (!src) return src;
    const resolved = resolveInlineMedia(src, attachmentsByName)?.filepath ?? src;
    return toAbsoluteFilePath(resolved, baseURL);
  }, [src, baseURL, attachmentsByName]);

  return <img src={fixedSrc} alt={alt} title={title} className={className} style={style} />;
});
img.displayName = 'MarkdownImage';
