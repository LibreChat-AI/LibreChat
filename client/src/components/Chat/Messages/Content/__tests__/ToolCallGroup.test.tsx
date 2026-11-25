import React from 'react';
import { RecoilRoot } from 'recoil';
import { foldHolds } from '@librechat/chat/components';
import { ContentTypes } from 'librechat-data-provider';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TMessageContentParts } from 'librechat-data-provider';
import { visitTaskTarget } from '~/components/Chat/BackgroundTasks/jump';
import ToolCallGroup from '../ToolCallGroup';

/** The package's parts read the localizer from the client package. */
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/MCP', () => ({
  useMCPIconMap: () => new Map(),
  useMCPServerNames: () => [],
}));

jest.mock('~/components/MCPUIResource', () => ({
  MCPAppViews: () => null,
}));

const makePart = (
  id: string,
  output = 'done',
  name = 'fetch_image',
  args: string | Record<string, unknown> = '{}',
): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name,
      args,
      output,
    },
  }) as unknown as TMessageContentParts;

const makeApprovalPart = (id: string, output = ''): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id,
      name: 'approval_probe',
      args: {},
      output,
      approval: {
        actionId: 'action-1',
        allowed_decisions: ['approve', 'reject'],
      },
    },
  }) as unknown as TMessageContentParts;

describe('ToolCallGroup as a fold a call can be followed into', () => {
  const parts = [
    { part: makePart('t1'), idx: 0 },
    { part: makePart('t2'), idx: 1 },
  ];

  it('answers for the calls it holds and opens when one of them is asked for', async () => {
    const { container } = render(
      <RecoilRoot>
        <div id="message-fold">
          <ToolCallGroup
            parts={parts}
            isSubmitting={false}
            isLast={false}
            showThinking={false}
            lastContentIdx={1}
            followedByAnswer
            renderPart={(part, idx) => (
              <div
                key={idx}
                data-task-tool-call={
                  part.type === ContentTypes.TOOL_CALL
                    ? part[ContentTypes.TOOL_CALL]?.id
                    : undefined
                }
              />
            )}
          />
        </div>
      </RecoilRoot>,
    );

    const root = container.querySelector('[data-fold-root]') as HTMLElement;
    expect(foldHolds(root, 't2')).toBe(true);
    expect(foldHolds(root, 't9')).toBe(false);
    const toggle = root.querySelector('[data-fold-toggle]') as HTMLElement;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('[data-task-tool-call="t2"]')).toBeNull();

    const reached = visitTaskTarget({
      id: 'tool:task',
      kind: 'tool',
      name: 'fetch_image',
      status: 'completed',
      messageId: 'message-fold',
      toolCallId: 't2',
    });

    expect(reached).toBe(true);
    const row = await waitFor(() => {
      const drawn = container.querySelector<HTMLElement>('[data-task-tool-call="t2"]');
      expect(drawn).not.toBeNull();
      return drawn as HTMLElement;
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(row).toHaveFocus());
  });

  /** Closed over a pending approval, a group keeps its rows in the document, hidden. The call
   *  is then found but cannot be reached, which is not the same as having nowhere to go. */
  it('opens when asked for a call it is still holding in the document, hidden', async () => {
    const { container } = render(
      <RecoilRoot>
        <div id="message-fold">
          <ToolCallGroup
            parts={[
              { part: makeApprovalPart('t1'), idx: 0 },
              { part: makeApprovalPart('t2'), idx: 1 },
            ]}
            isSubmitting={false}
            isLast={false}
            showThinking={false}
            lastContentIdx={1}
            renderPart={(part, idx) => (
              <div
                key={idx}
                data-task-tool-call={
                  part.type === ContentTypes.TOOL_CALL
                    ? part[ContentTypes.TOOL_CALL]?.id
                    : undefined
                }
              />
            )}
          />
        </div>
      </RecoilRoot>,
    );

    const root = container.querySelector('[data-fold-root]') as HTMLElement;
    const toggle = root.querySelector('[data-fold-toggle]') as HTMLElement;
    const panel = screen.getByTestId('tool-call-group-panel');
    if (toggle.getAttribute('aria-expanded') === 'true') {
      fireEvent.click(toggle);
      fireEvent.transitionEnd(panel);
    }
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    const held = container.querySelector<HTMLElement>('[data-task-tool-call="t2"]');
    expect(held).not.toBeNull();

    const reached = visitTaskTarget({
      id: 'tool:task',
      kind: 'tool',
      name: 'approval_probe',
      status: 'running',
      messageId: 'message-fold',
      toolCallId: 't2',
    });

    expect(reached).toBe(true);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    expect(panel).toHaveAttribute('aria-hidden', 'false');
    await waitFor(() =>
      expect(container.querySelector('[data-task-tool-call="t2"]')).toHaveFocus(),
    );
  });
});
