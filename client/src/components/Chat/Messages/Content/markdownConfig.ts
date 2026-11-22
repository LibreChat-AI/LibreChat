import remarkDirective from 'remark-directive';
import { rehypeList, replyRemark, markdownElements } from '@librechat/chat/components';
import type { MarkdownBlocksProps } from '@librechat/chat/components';
import type { MarkdownExtensions } from '@librechat/chat/react';
import type { ElementType } from 'react';
import type { RehypeModules } from './rehype';
import {
  mcpUIResourcePlugin,
  MCPUIResource,
  MCPUIResourceCarousel,
} from '~/components/MCPUIResource';
import { Citation, CompositeCitation, HighlightedText } from '~/components/Web/Citation';
import { Artifact, artifactPlugin } from '~/components/Artifacts/Artifact';
import { setAppMarkdownExtensions } from './Parts/slots';
import { unicodeCitation } from '~/components/Web';
/* The reply's elements come from the chat package; this registers the code block and the diagram
 * this app draws them with. */
import './MarkdownComponents';

type Plugins = MarkdownBlocksProps['remarkPlugins'];

let extensions: MarkdownExtensions | null = null;

/**
 * What this app adds to a reply's markdown: artifacts (and the directive syntax they are written
 * in), citations and embedded MCP resources. Built on first use and kept: the artifact, citation
 * and resource modules import one another in a cycle (through the parts that render markdown), so
 * reading them while this module loads throws under native ESM.
 */
export function getMarkdownExtensions(): MarkdownExtensions {
  extensions ??= {
    remarkPlugins: [
      remarkDirective,
      /* The artifact plugin is typed against the `unified` this app resolves, which is older
         than the one `react-markdown` runs it on, so the cast is on its type alone. */
      artifactPlugin as unknown as Plugins[number],
      unicodeCitation,
      mcpUIResourcePlugin,
    ],
    elements: {
      artifact: Artifact,
      citation: Citation,
      'highlighted-text': HighlightedText,
      'composite-citation': CompositeCitation,
      'mcp-ui-resource': MCPUIResource,
      'mcp-ui-carousel': MCPUIResourceCarousel,
    },
  };
  return extensions;
}

setAppMarkdownExtensions(getMarkdownExtensions);

/**
 * The reply renderer's pipeline, as the chat package composes it from its own plugins and this
 * app's additions. Specs and benchmarks render with these so they run what a reply runs.
 */
export const getRemarkPlugins = (latexParsing = true): Plugins =>
  replyRemark(latexParsing, getMarkdownExtensions().remarkPlugins);

/** Empty until `useRehypeModules` has loaded KaTeX and highlight.js; see `./rehype`. */
export const getRehypePlugins = (modules: RehypeModules | null): Plugins => rehypeList(modules);

export const getMarkdownComponents = (): { [nodeType: string]: ElementType } => ({
  ...markdownElements,
  ...getMarkdownExtensions().elements,
});
