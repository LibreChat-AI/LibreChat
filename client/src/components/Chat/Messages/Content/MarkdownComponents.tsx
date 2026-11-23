import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { markdownElements, markdownPreviewElements } from '@librechat/chat/components';
import type { MarkdownCodeBlockProps } from '@librechat/chat/react';
import type { ElementType } from 'react';
import Mermaid, { MermaidErrorBoundary } from '~/components/Messages/Content/Mermaid';
import CodeBlock from '~/components/Messages/Content/CodeBlock';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import { setAppMarkdownSlots } from './Parts/slots';

type BlockProps = Omit<MarkdownCodeBlockProps, 'executable'>;

/** A reply's code block: it can run where the user's role may run code. */
function ExecutableCodeBlock(props: BlockProps) {
  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });
  return <CodeBlock {...props} allowExecution={canRunCode} />;
}

setAppMarkdownSlots({
  renderCodeBlock: ({ executable, ...props }) =>
    executable ? (
      <ExecutableCodeBlock {...props} />
    ) : (
      <CodeBlock {...props} allowExecution={false} />
    ),
  renderMermaid: ({ code, id, guarded }) =>
    guarded ? (
      <MermaidErrorBoundary code={code}>
        <Mermaid id={id}>{code}</Mermaid>
      </MermaidErrorBoundary>
    ) : (
      <Mermaid>{code}</Mermaid>
    ),
});

/** The chat package's markdown elements, named as this app's renderers import them. Importing
 *  them from here is what registers the slots above. */
export const code: ElementType = markdownElements.code;
export const codeNoExecution: ElementType = markdownPreviewElements.code;
export const a: ElementType = markdownElements.a;
export const p: ElementType = markdownElements.p;
export const img: ElementType = markdownElements.img;
export const table: ElementType = markdownElements.table;
export const ul: ElementType = markdownElements.ul;
export const ol: ElementType = markdownElements.ol;
export const h1: ElementType = markdownElements.h1;
export const h2: ElementType = markdownElements.h2;
export const h3: ElementType = markdownElements.h3;
export const h4: ElementType = markdownElements.h4;
export const h5: ElementType = markdownElements.h5;
export const h6: ElementType = markdownElements.h6;
export const blockquote: ElementType = markdownElements.blockquote;
