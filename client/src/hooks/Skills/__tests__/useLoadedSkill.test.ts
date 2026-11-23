import { renderHook } from '@testing-library/react';
import useLoadedSkill from '../useLoadedSkill';

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
}));

jest.mock('~/data-provider', () => ({
  useSkillsInfiniteQuery: (...args: unknown[]) => mockSkillsQuery(...args),
  useGetSkillQuery: (...args: unknown[]) => mockSkillQuery(...args),
}));

const SKILL = {
  _id: 'skill-1',
  name: 'release-notes',
  body: '# Release notes\nSummarize merged PRs.',
};

const lookup = (enabled = true) =>
  renderHook(() => useLoadedSkill('release-notes', enabled)).result.current;

describe('useLoadedSkill', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockSkillsQuery.mockReset();
    mockSkillQuery.mockReset();
    mockHasAccess.mockReturnValue(true);
    mockSkillsQuery.mockReturnValue({
      data: { pages: [{ skills: [{ _id: 'other', name: 'release' }, SKILL] }] },
    });
    mockSkillQuery.mockImplementation((id: string | undefined) => ({
      data: id === SKILL._id ? SKILL : undefined,
    }));
  });

  it('resolves the one accessible skill with the name and opens it', () => {
    const skill = lookup();

    expect(mockSkillsQuery).toHaveBeenCalledWith(
      { search: 'release-notes', limit: 10 },
      { enabled: true },
    );
    expect(skill?.instructions).toBe(SKILL.body);

    skill?.open();
    expect(mockNavigate).toHaveBeenCalledWith('/skills/skill-1');
  });

  it('resolves nothing for a skill outside the library', () => {
    mockSkillsQuery.mockReturnValue({ data: { pages: [{ skills: [] }] } });

    expect(lookup()).toBeUndefined();
  });

  it('resolves nothing when two accessible skills share the name', () => {
    mockSkillsQuery.mockReturnValue({
      data: {
        pages: [{ skills: [SKILL, { ...SKILL, _id: 'skill-2' }], has_more: false }],
      },
    });

    expect(lookup()).toBeUndefined();
  });

  it('resolves nothing while more results could hold another same-name skill', () => {
    mockSkillsQuery.mockReturnValue({ data: { pages: [{ skills: [SKILL], has_more: true }] } });

    expect(lookup()).toBeUndefined();
  });

  it('neither fetches nor resolves the skill without skills access', () => {
    mockHasAccess.mockReturnValue(false);

    expect(lookup()).toBeUndefined();
    expect(mockSkillsQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
    expect(mockSkillQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it('neither fetches nor resolves the skill while the lookup is off', () => {
    expect(lookup(false)).toBeUndefined();
    expect(mockSkillsQuery).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });
});
