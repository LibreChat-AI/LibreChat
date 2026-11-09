import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ShareContext } from '~/Providers/ShareContext';
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

    expect(screen.getByText('com_ui_skill_current_version')).toBeInTheDocument();
    expect(screen.getByText(/Summarize merged PRs\./)).toBeInTheDocument();
    expect(screen.queryByText(/loaded\. Follow the instructions/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_open_skill' }));
    expect(mockNavigate).toHaveBeenCalledWith('/skills/skill-1');
  });

  it('keeps an execution warning in the output beside the instructions', () => {
    render(
      <SkillCall
        initialProgress={1}
        isSubmitting={false}
        args={JSON.stringify({ skillName: 'release-notes' })}
        output={
          'Skill "release-notes" loaded. Follow the instructions below.\n\n' +
          "Note: this skill's bundled files could not be loaded into the code environment."
        }
      />,
    );

    expect(screen.getByText(/Summarize merged PRs\./)).toBeInTheDocument();
    expect(screen.getByText(/bundled files could not be loaded/)).toBeInTheDocument();
  });

  it('falls back to the tool output for a skill outside the library', () => {
    mockSkillsQuery.mockReturnValue({ data: { pages: [{ skills: [] }] } });
    renderSkill();

    expect(screen.getByText('com_ui_output')).toBeInTheDocument();
    expect(screen.getByText(/loaded\. Follow the instructions/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_open_skill' })).not.toBeInTheDocument();
  });

  it('keeps the output when two accessible skills share the name', () => {
    mockSkillsQuery.mockReturnValue({
      data: {
        pages: [{ skills: [SKILL, { ...SKILL, _id: 'skill-2' }], has_more: false }],
      },
    });
    renderSkill();

    expect(screen.getByText(/loaded\. Follow the instructions/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_open_skill' })).not.toBeInTheDocument();
  });

  it('keeps the output while more results could hold another same-name skill', () => {
    mockSkillsQuery.mockReturnValue({ data: { pages: [{ skills: [SKILL], has_more: true }] } });
    renderSkill();

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

  it("keeps the output instead of the viewer's same-named skill in a shared transcript", () => {
    render(
      <ShareContext.Provider value={{ isSharedConvo: true, shareId: 'share-1' }}>
        <SkillCall
          initialProgress={1}
          isSubmitting={false}
          args={JSON.stringify({ skillName: 'release-notes' })}
          output='Skill "release-notes" loaded. Follow the instructions below.'
        />
      </ShareContext.Provider>,
    );

    expect(screen.getByText('com_ui_output')).toBeInTheDocument();
    expect(screen.getByText(/loaded\. Follow the instructions/)).toBeInTheDocument();
    expect(screen.queryByText(/Summarize merged PRs\./)).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_skill_current_version')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_open_skill' })).not.toBeInTheDocument();
    expect(mockSkillsQuery).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });
});
