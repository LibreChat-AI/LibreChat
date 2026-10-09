import { memo, useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import supersub from 'remark-supersub';
import { Link } from 'react-router-dom';
import rehypeHighlight from 'rehype-highlight';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { AnchorHTMLAttributes } from 'react';
import type { PluggableList } from 'unified';
import type { Element } from 'hast';
import { codeNoExecution } from '~/components/Chat/Messages/Content/MarkdownComponents';
import { langSubset } from '~/utils';

const REMARK_PLUGINS: PluggableList = [
  supersub,
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
];

const REHYPE_PLUGINS: PluggableList = [
  [rehypeKatex],
  [
    rehypeHighlight,
    {
      detect: true,
      ignoreMissing: true,
      subset: langSubset,
    },
  ],
];

const MARKDOWN_COMPONENTS = { code: codeNoExecution };
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const TEL_PROTOCOL_PATTERN = /^tel:/i;

type MarkdownLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { node?: Element };

interface SkillMarkdownLinkProps extends MarkdownLinkProps {
  skillId: string;
  currentFilePath: string;
}

function isRelativeFileLink(href: string): boolean {
  return (
    href.length > 0 &&
    !href.startsWith('/') &&
    !href.startsWith('#') &&
    !href.startsWith('?') &&
    !URI_SCHEME_PATTERN.test(href)
  );
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function normalizeSkillPath(currentFilePath: string, targetPath: string): string {
  const currentDirectory = currentFilePath.split('/').slice(0, -1);

  return [...currentDirectory, ...decodePath(targetPath).split('/')]
    .reduce<string[]>((segments, segment) => {
      if (!segment || segment === '.') {
        return segments;
      }
      if (segment === '..') {
        segments.pop();
        return segments;
      }
      segments.push(segment);
      return segments;
    }, [])
    .join('/');
}

function getSkillFileRoute(skillId: string, currentFilePath: string, href: string): string | null {
  if (!isRelativeFileLink(href)) {
    return null;
  }

  const suffixIndex = href.search(/[?#]/);
  const targetPath = suffixIndex === -1 ? href : href.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : href.slice(suffixIndex);
  const relativePath = normalizeSkillPath(currentFilePath, targetPath);

  if (!relativePath) {
    return null;
  }

  const route = `/skills/${encodeURIComponent(skillId)}?file=${encodeURIComponent(relativePath)}`;
  return suffix.startsWith('?') ? `${route}&${suffix.slice(1)}` : `${route}${suffix}`;
}

function SkillMarkdownLink({
  node: _node,
  href,
  skillId,
  currentFilePath,
  children,
  ...props
}: SkillMarkdownLinkProps) {
  const fileRoute = href ? getSkillFileRoute(skillId, currentFilePath, href) : null;

  if (!fileRoute) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }

  return (
    <Link to={fileRoute} {...props}>
      {children}
    </Link>
  );
}

function skillUrlTransform(value: string): string {
  return TEL_PROTOCOL_PATTERN.test(value) ? value : defaultUrlTransform(value);
}

interface SkillMarkdownRendererProps {
  content: string;
  skillId: string;
  currentFilePath: string;
  className?: string;
}

function SkillMarkdownRenderer({
  content,
  skillId,
  currentFilePath,
  className,
}: SkillMarkdownRendererProps) {
  const components = useMemo(
    () => ({
      ...MARKDOWN_COMPONENTS,
      a: (props: MarkdownLinkProps) => (
        <SkillMarkdownLink {...props} skillId={skillId} currentFilePath={currentFilePath} />
      ),
    }),
    [skillId, currentFilePath],
  );

  return (
    <ReactMarkdown
      /** @ts-ignore - PluggableList vs Pluggable[] shape drift */
      remarkPlugins={REMARK_PLUGINS}
      /** @ts-ignore - PluggableList vs Pluggable[] shape drift */
      rehypePlugins={REHYPE_PLUGINS}
      components={components as unknown as Record<string, React.ElementType>}
      urlTransform={skillUrlTransform}
      className={
        className ??
        'markdown prose dark:prose-invert light w-full break-words leading-[1.65rem] text-text-primary'
      }
    >
      {content}
    </ReactMarkdown>
  );
}

export default memo(SkillMarkdownRenderer);
