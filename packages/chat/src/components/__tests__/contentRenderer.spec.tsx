/** @jest-environment jsdom */
import { ContentTypes } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { ContentPartsProps, ContentPartsSlots } from '../contentTypes';
import type { ContentPartsSlotProps } from '../../react/host';
import { createMessagePartsHost } from '../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../react/host';

const seen: ContentPartsProps[] = [];

jest.mock('../ContentParts', () => {
  const actual = jest.requireActual<typeof import('../ContentParts')>('../ContentParts');
  return {
    ContentParts: (props: ContentPartsProps) => {
      seen.push(props);
      return <actual.ContentParts {...props} />;
    },
  };
});

import { contentPartsRenderer, renderContentParts } from '../contentRenderer';

const base: ContentPartsSlotProps = {
  content: [{ type: ContentTypes.TEXT, text: 'Here is the answer' } as TMessageContentParts],
  messageId: 'assistant-1',
  conversationId: 'convo-1',
  isSubmitting: false,
  showThinking: false,
};

const draw = (node: React.ReactNode) =>
  render(
    <MessagePartsHostProvider host={createMessagePartsHost({ renderContentParts: undefined })}>
      {node}
    </MessagePartsHostProvider>,
  );

beforeEach(() => {
  seen.length = 0;
});

describe('contentPartsRenderer', () => {
  it('draws a message with the package renderer and no slots by default', () => {
    draw(renderContentParts(base));

    expect(screen.getByText('Here is the answer')).toBeInTheDocument();
    expect(seen[0].slots).toBeUndefined();
  });

  it('fills the row fields a caller leaves out with an assistant reply’s', () => {
    draw(renderContentParts({ ...base, isSubmitting: true }));
    expect(seen[0]).toMatchObject({
      isCreatedByUser: false,
      isLast: true,
      isSubmitting: true,
      isLatestMessage: true,
    });
  });

  it('keeps the row fields a caller states', () => {
    draw(
      renderContentParts({
        ...base,
        isSubmitting: true,
        isLatestMessage: false,
        isLast: false,
        isCreatedByUser: true,
      }),
    );
    expect(seen[0]).toMatchObject({
      isCreatedByUser: true,
      isLast: false,
      isSubmitting: true,
      isLatestMessage: false,
    });
  });

  it('hands the host’s slots to the renderer, the same object every time', () => {
    const slots: ContentPartsSlots = { renderSources: () => null };
    const renderer = contentPartsRenderer(slots);
    draw(renderer(base));
    draw(renderer({ ...base, messageId: 'assistant-2' }));

    expect(seen[0].slots).toBe(slots);
    expect(seen[1].slots).toBe(slots);
  });
});
