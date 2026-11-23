/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LoadedSkill, MessagePartsShare } from '../../../react/host';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import SkillCall from '../SkillCall';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

jest.mock('../ProgressText', () => ({
  __esModule: true,
  default: ({ finishedText }: { finishedText: string }) => <div>{finishedText}</div>,
}));

jest.mock('../Attachment', () => ({
  __esModule: true,
  ...jest.requireActual('../Attachment'),
  AttachmentGroup: () => null,
}));

jest.mock('../useToolCallState', () => ({
  __esModule: true,
  default: ({ output }: { output: string }) => ({
    showCode: true,
    toggleCode: jest.fn(),
    expandStyle: {},
    expandRef: { current: null },
    phase: 'completed',
    hasOutput: output.length > 0,
    bare: false,
    rowRef: { current: null },
  }),
}));

const open = jest.fn();
const SKILL: LoadedSkill = { instructions: '# Release notes\nSummarize merged PRs.\n', open };
const LOADED = 'Skill "release-notes" loaded. Follow the instructions below.';

/** The host's lookup, recording what the card asked for. */
const lookup = jest.fn<LoadedSkill | undefined, [string, boolean]>();
let share: MessagePartsShare = {};

const host = createMessagePartsHost({
  useShare: () => share,
  useLoadedSkill: (name, enabled) => lookup(name, enabled),
});

function renderSkill(output = LOADED) {
  return render(
    <MessagePartsHostProvider host={host}>
      <SkillCall
        initialProgress={1}
        isSubmitting={false}
        args={JSON.stringify({ skillName: 'release-notes' })}
        output={output}
      />
    </MessagePartsHostProvider>,
  );
}

describe('SkillCall', () => {
  beforeEach(() => {
    open.mockReset();
    lookup.mockReset();
    lookup.mockImplementation((_name, enabled) => (enabled ? SKILL : undefined));
    share = {};
  });

  it('shows the loaded skill instructions and opens the skill', () => {
    renderSkill();

    expect(lookup).toHaveBeenLastCalledWith('release-notes', true);
    expect(screen.getByText('com_ui_skill_current_version')).toBeInTheDocument();
    expect(screen.getByText(/Summarize merged PRs\./)).toBeInTheDocument();
    expect(screen.queryByText(/loaded\. Follow the instructions/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_open_skill' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps an execution warning in the output beside the instructions', () => {
    renderSkill(
      `${LOADED}\n\n` +
        "Note: this skill's bundled files could not be loaded into the code environment.",
    );

    expect(screen.getByText(/Summarize merged PRs\./)).toBeInTheDocument();
    expect(screen.getByText(/bundled files could not be loaded/)).toBeInTheDocument();
  });

  it('falls back to the tool output when the host names no skill', () => {
    lookup.mockReturnValue(undefined);
    renderSkill();

    expect(screen.getByText('com_ui_output')).toBeInTheDocument();
    expect(screen.getByText(/loaded\. Follow the instructions/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_open_skill' })).not.toBeInTheDocument();
  });

  it("keeps the output instead of the viewer's same-named skill in a shared transcript", () => {
    share = { isSharedConvo: true, shareId: 'share-1' };
    renderSkill();

    expect(lookup).toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalledWith(expect.anything(), true);
    expect(screen.getByText('com_ui_output')).toBeInTheDocument();
    expect(screen.getByText(/loaded\. Follow the instructions/)).toBeInTheDocument();
    expect(screen.queryByText(/Summarize merged PRs\./)).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_skill_current_version')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_open_skill' })).not.toBeInTheDocument();
  });
});
