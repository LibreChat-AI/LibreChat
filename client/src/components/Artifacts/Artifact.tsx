import { useEffect, useMemo, useRef } from 'react';
import { visit } from 'unist-util-visit';
import { useLocation } from 'react-router-dom';
import { useIsPartsPreview } from '@librechat/chat/react';
import type { Extension } from 'mdast-util-from-markdown';
import type { ReactNode } from 'react';
import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import type { Artifact } from '~/common';
import { useMessageContext, useArtifactContext } from '~/Providers';
import { extractContent, isArtifactRoute } from '~/utils';
import { normalizeArtifactType } from '~/utils/artifacts';
import ArtifactButton from './ArtifactButton';

/** An implicitly closed container has no second fence token, even when it parses at EOF. */
const trackClosers: Extension = {
  exit: {
    directiveContainerFence(token) {
      const node = this.stack.at(-1);
      if (
        node?.type === 'containerDirective' &&
        node.name === 'artifact' &&
        node.position?.start.offset !== token.start.offset
      ) {
        node.data = { ...node.data, artifactCloseOffset: token.end.offset };
      }
    },
  },
};

type Completion = 'open' | 'closing' | 'closed';

export const artifactPlugin: Plugin<[], Root> = function () {
  const data = this.data() as { fromMarkdownExtensions?: Array<Extension | Extension[]> };
  (data.fromMarkdownExtensions ??= []).push(trackClosers);

  return (tree, file) => {
    visit(tree, ['textDirective', 'leafDirective', 'containerDirective'], (node, index, parent) => {
      if (node.type === 'textDirective') {
        if (parent && Array.isArray(parent.children) && typeof index === 'number') {
          parent.children[index] = { type: 'text', value: `:${node.name}` };
        }
        return;
      }
      if (
        (node.type !== 'leafDirective' && node.type !== 'containerDirective') ||
        node.name !== 'artifact'
      ) {
        return;
      }
      let artifactCompletion: Completion = 'open';
      const close = node.data?.artifactCloseOffset;
      if (node.type === 'leafDirective') {
        artifactCompletion = 'closed';
      } else if (typeof close === 'number') {
        artifactCompletion = close < String(file.value).length ? 'closed' : 'closing';
      }
      node.data = {
        ...node.data,
        hName: 'artifact',
        hProperties: { ...node.attributes, artifactCompletion },
      };
    });
  };
};

interface ArtifactProps {
  title?: string;
  type?: string;
  identifier?: string;
  artifactCompletion?: Completion;
  children?: ReactNode;
  node?: unknown;
}

export function Artifact({
  title,
  type,
  identifier,
  artifactCompletion = 'closed',
  children,
}: ArtifactProps) {
  const { pathname } = useLocation();
  const isPreview = useIsPartsPreview();
  const { messageId, isSubmitting, isLatestMessage, nextType } = useMessageContext();
  const { getNextIndex, resetCounter, provisionalEnd } = useArtifactContext();
  const index = useRef(getNextIndex(false)).current;
  useEffect(resetCounter);

  const streaming = isSubmitting === true && isLatestMessage !== false && nextType == null;
  const complete =
    artifactCompletion === 'closed' ||
    (artifactCompletion === 'closing' && !(streaming && provisionalEnd));
  const displayTitle = title ?? 'untitled';
  const normalizedType = normalizeArtifactType(type ?? 'unknown');
  const id = `${identifier ?? 'lc-no-identifier'}_${type ?? 'unknown'}_${displayTitle}_${messageId}`
    .replace(/\s+/g, '_')
    .toLowerCase();
  const content = complete ? extractContent(children) : undefined;
  const artifact = useMemo<Artifact | null>(
    () =>
      content == null
        ? null
        : {
            id,
            identifier,
            title: displayTitle,
            type: normalizedType,
            messageId,
            index,
            content,
            lastUpdateTime: Date.now(),
          },
    [id, identifier, displayTitle, normalizedType, messageId, index, content],
  );

  if (title == null && type == null && identifier == null) {
    return null;
  }

  return (
    <ArtifactButton
      artifact={artifact}
      identifier={identifier}
      title={title}
      type={normalizedType}
      streaming={streaming}
      canOpen={!isPreview && isArtifactRoute(pathname)}
    />
  );
}
