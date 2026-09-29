import React from 'react';
import { RecoilRoot } from 'recoil';
import ReactMarkdown from 'react-markdown';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { getRemarkPlugins, getRehypePlugins, getMarkdownComponents } from '../markdownConfig';
import { MessageContext, ArtifactProvider, CodeBlockProvider } from '~/Providers';
import Markdown from '../Markdown';

/**
 * End-to-end artifact-index regression tests. The real `Artifact` component
 * computes its document-order index via the (per-block) ArtifactProvider and
 * stores it on the artifact passed to `ArtifactButton`; we stub only
 * `ArtifactButton` to read that index back. This verifies the per-block base
 * indexing assigns artifacts the same indices the whole-message renderer did —
 * the index used by artifact edit/update calls.
 */
jest.mock('~/components/Artifacts/ArtifactButton', () => ({
  __esModule: true,
  default: ({
    artifact,
  }: {
    artifact?: { index?: number; identifier?: string; content?: string };
  }) => (
    <div
      data-testid="art"
      data-index={String(artifact?.index)}
      data-id={String(artifact?.identifier)}
      data-content={String(artifact?.content ?? '')}
    />
  ),
}));

const artifact = (id: string, title: string) =>
  `:::artifact{identifier="${id}" type="text/markdown" title="${title}"}\nhello ${id}\n:::`;

const wrap = (ui: React.ReactNode) => (
  <MemoryRouter>
    <RecoilRoot>
      <MessageContext.Provider value={{ messageId: 'm1', isExpanded: true }}>
        {ui}
      </MessageContext.Provider>
    </RecoilRoot>
  </MemoryRouter>
);

/** The previous whole-message renderer: one ReactMarkdown under one ArtifactProvider. */
const OldMarkdown = ({ content }: { content: string }) => (
  <ArtifactProvider>
    <CodeBlockProvider>
      <ReactMarkdown
        /** @ts-ignore */
        remarkPlugins={getRemarkPlugins()}
        /** @ts-ignore */
        rehypePlugins={getRehypePlugins()}
        components={getMarkdownComponents()}
      >
        {content}
      </ReactMarkdown>
    </CodeBlockProvider>
  </ArtifactProvider>
);

const readArtifacts = async () =>
  (await screen.findAllByTestId('art')).map((el) => ({
    idx: el.getAttribute('data-index'),
    id: el.getAttribute('data-id'),
  }));

/** The latest message of a conversation, generating while `submitting` holds. */
const liveView = (content: string, submitting: boolean) => (
  <MemoryRouter>
    <RecoilRoot>
      <MessageContext.Provider
        value={{
          messageId: 'm1',
          isExpanded: true,
          isSubmitting: submitting,
          isLatestMessage: true,
        }}
      >
        <Markdown content={content} isLatestMessage={true} />
      </MessageContext.Provider>
    </RecoilRoot>
  </MemoryRouter>
);

/**
 * A finished message renders through one pipeline; one that streamed in this view
 * renders per block. Every parity case has to hold on both paths.
 */
const renderMessage = (content: string, streamed: boolean) => {
  const rendered = render(liveView(content, streamed));
  rendered.rerender(liveView(content, false));
  return rendered;
};

describe.each([
  ['a finished', false],
  ['a streamed', true],
])('MarkdownBlocks artifact-index parity (e2e) in %s message', (_label, streamed) => {
  it('assigns document-order indices to multiple artifacts', async () => {
    const content = `${artifact('a', 'A')}\n\n${artifact('b', 'B')}`;
    renderMessage(content, streamed);

    expect(await readArtifacts()).toEqual([
      { idx: '0', id: 'a' },
      { idx: '1', id: 'b' },
    ]);
  });

  it('matches the whole-message renderer indices (text + artifacts interleaved)', async () => {
    const content = `Intro.\n\n${artifact('a', 'A')}\n\nMiddle.\n\n${artifact('b', 'B')}\n\nEnd.`;

    const { unmount } = render(wrap(<OldMarkdown content={content} />));
    const oldIdx = await readArtifacts();
    unmount();

    renderMessage(content, streamed);
    const newIdx = await readArtifacts();

    expect(newIdx).toEqual(oldIdx);
    expect(newIdx).toEqual([
      { idx: '0', id: 'a' },
      { idx: '1', id: 'b' },
    ]);
  });

  /**
   * A finished message moves to per-block rendering on its first edit, and per
   * block the base-aware keys remount the blocks whose index shifted.
   */
  it('refreshes artifact indices when an in-place edit inserts an artifact before another', async () => {
    const before = `Intro.\n\n${artifact('b', 'B')}`;
    const after = `${artifact('a', 'A')}\n\n${artifact('b', 'B')}`;

    const { rerender } = renderMessage(before, streamed);
    expect(await readArtifacts()).toEqual([{ idx: '0', id: 'b' }]);

    rerender(liveView(after, false));
    // 'b' was index 0; inserting 'a' before it shifts it to 1. Without a remount
    // its ref-cached index would stay 0 (duplicating 'a').
    expect(await readArtifacts()).toEqual([
      { idx: '0', id: 'a' },
      { idx: '1', id: 'b' },
    ]);
  });

  it('does not consume an index for inline text artifact directives', async () => {
    // `:artifact{}` (text directive) renders as literal text, not an Artifact, so
    // the following real artifact must still be index 0.
    const content = `See :artifact{identifier="x"} inline.\n\n${artifact('a', 'A')}`;
    renderMessage(content, streamed);

    expect(await readArtifacts()).toEqual([{ idx: '0', id: 'a' }]);
  });

  it('preserves markdown artifact content with inner fenced code blocks', async () => {
    const markdown = [
      '# Title',
      '',
      '```bash',
      'echo one',
      '```',
      'Text between sections.',
      '## Section B',
      '```bash',
      'echo two',
      '```',
    ].join('\n');
    const content = [
      ':::artifact{identifier="git-cheatsheet" type="text/markdown" title="Git Cheatsheet"}',
      '````markdown',
      markdown,
      '````',
      ':::',
    ].join('\n');

    renderMessage(content, streamed);

    const [artifactNode] = await screen.findAllByTestId('art');
    expect(artifactNode.getAttribute('data-content')).toBe(`${markdown}\n`);
  });
});
