/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LoadedSkill, MessagePartsShare } from '../../../react/host';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import { initEnglish } from '../../../__fixtures__/i18n';
import SkillCall from '../SkillCall';

beforeAll(initEnglish);

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
const SKILL_ID = '6650f0c2a1b2c3d4e5f60718';
const SKILL: LoadedSkill = { instructions: '# Release notes\nSummarize merged PRs.\n', open };
const LOADED = 'Skill "release-notes" loaded. Follow the instructions below.';

/** The host's lookup, recording what the card asked for. It knows one skill, by its id. */
const lookup = jest.fn<LoadedSkill | undefined, [string, boolean]>();
let share: MessagePartsShare = {};

const host = createMessagePartsHost({
  useShare: () => share,
  useLoadedSkill: (id, enabled) => lookup(id, enabled),
});

function renderSkill({ output = LOADED, skillId }: { output?: string; skillId?: string } = {}) {
  return render(
    <MessagePartsHostProvider host={host}>
      <SkillCall
        initialProgress={1}
        isSubmitting={false}
        args={JSON.stringify({ skillName: 'release-notes' })}
        skillId={skillId}
        output={output}
      />
    </MessagePartsHostProvider>,
  );
}

describe('SkillCall', () => {
  beforeEach(() => {
    open.mockReset();
    lookup.mockReset();
    lookup.mockImplementation((id, enabled) => (enabled && id === SKILL_ID ? SKILL : undefined));
    share = {};
  });

  it('shows the instructions of the skill the call loaded and opens it', () => {
    renderSkill({ skillId: SKILL_ID });

    expect(lookup).toHaveBeenLastCalledWith(SKILL_ID, true);
    expect(screen.getByText('Current skill version')).toBeInTheDocument();
    expect(screen.getByText(/Summarize merged PRs\./)).toBeInTheDocument();
    expect(screen.queryByText(/loaded\. Follow the instructions/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open skill' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps an execution warning in the output beside the instructions', () => {
    renderSkill({
      skillId: SKILL_ID,
      output:
        `${LOADED}\n\n` +
        "Note: this skill's bundled files could not be loaded into the code environment.",
    });

    expect(screen.getByText(/Summarize merged PRs\./)).toBeInTheDocument();
    expect(screen.getByText(/bundled files could not be loaded/)).toBeInTheDocument();
  });

  it('falls back to the tool output when the reader cannot open the skill', () => {
    renderSkill({ skillId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });

    expect(lookup).toHaveBeenLastCalledWith('aaaaaaaaaaaaaaaaaaaaaaaa', true);
    expect(screen.getByText('Output')).toBeInTheDocument();
    expect(screen.getByText(/loaded\. Follow the instructions/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open skill' })).not.toBeInTheDocument();
  });

  it('keeps the output of a call saved without a skill id and looks nothing up', () => {
    renderSkill();

    expect(lookup).toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalledWith(expect.anything(), true);
    expect(screen.getByText('Output')).toBeInTheDocument();
    expect(screen.getByText(/loaded\. Follow the instructions/)).toBeInTheDocument();
    expect(screen.queryByText('Current skill version')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open skill' })).not.toBeInTheDocument();
  });

  it('keeps the output in a shared transcript and looks nothing up', () => {
    share = { isSharedConvo: true, shareId: 'share-1' };
    renderSkill({ skillId: SKILL_ID });

    expect(lookup).toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalledWith(expect.anything(), true);
    expect(screen.getByText('Output')).toBeInTheDocument();
    expect(screen.getByText(/loaded\. Follow the instructions/)).toBeInTheDocument();
    expect(screen.queryByText(/Summarize merged PRs\./)).not.toBeInTheDocument();
    expect(screen.queryByText('Current skill version')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open skill' })).not.toBeInTheDocument();
  });
});
