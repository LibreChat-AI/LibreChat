import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import SkillCall from '../SkillCall';

const mockNavigate = jest.fn();
const mockHasAccess = jest.fn(() => true);
const mockSkillsQuery = jest.fn();
const mockSkillQuery = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('~/hooks', () => ({
  useHasAccess: () => mockHasAccess(),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useSkillsInfiniteQuery: (...args: unknown[]) => mockSkillsQuery(...args),
  useGetSkillQuery: (...args: unknown[]) => mockSkillQuery(...args),
}));

jest.mock('~/components/Chat/Messages/Content/ProgressText', () => ({
  __esModule: true,
  default: ({ finishedText }: { finishedText: string }) => <div>{finishedText}</div>,
}));

jest.mock('../Attachment', () => ({
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

const SKILL = {
  _id: 'skill-1',
  name: 'release-notes',
  body: '# Release notes\nSummarize merged PRs.',
};

function renderSkill() {
  return render(
    <SkillCall
      initialProgress={1}
      isSubmitting={false}
      args={JSON.stringify({ skillName: 'release-notes' })}
      output='Skill "release-notes" loaded. Follow the instructions below.'
    />,
  );
}

describe('SkillCall', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockHasAccess.mockReturnValue(true);
    mockSkillsQuery.mockReturnValue({
      data: { pages: [{ skills: [{ _id: 'other', name: 'release' }, SKILL] }] },
    });
    mockSkillQuery.mockImplementation((id: string | undefined) => ({
      data: id === SKILL._id ? SKILL : undefined,
    }));
  });

  it('shows the loaded skill instructions and opens the skill', () => {
    renderSkill();

    expect(screen.getByText('com_ui_skill_instructions')).toBeInTheDocument();
    expect(screen.getByText(/Summarize merged PRs\./)).toBeInTheDocument();
    expect(screen.queryByText(/loaded\. Follow the instructions/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_open_skill' }));
    expect(mockNavigate).toHaveBeenCalledWith('/skills/skill-1');
  });

  it('falls back to the tool output for a skill outside the library', () => {
    mockSkillsQuery.mockReturnValue({ data: { pages: [{ skills: [] }] } });
    renderSkill();

    expect(screen.getByText('com_ui_output')).toBeInTheDocument();
    expect(screen.getByText(/loaded\. Follow the instructions/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_open_skill' })).not.toBeInTheDocument();
  });

  it('neither fetches nor links the skill without skills access', () => {
    mockHasAccess.mockReturnValue(false);
    renderSkill();

    expect(mockSkillsQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.getByText('com_ui_output')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_open_skill' })).not.toBeInTheDocument();
  });
});
