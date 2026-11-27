import { renderHook } from '@testing-library/react';
import useLoadedSkill from '../useLoadedSkill';

const mockNavigate = jest.fn();
const mockHasAccess = jest.fn(() => true);
const mockSkillQuery = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('~/hooks', () => ({
  useHasAccess: () => mockHasAccess(),
}));

jest.mock('~/data-provider', () => ({
  useGetSkillQuery: (...args: unknown[]) => mockSkillQuery(...args),
}));

const SKILL = {
  _id: '6650f0c2a1b2c3d4e5f60718',
  name: 'release-notes',
  body: '# Release notes\nSummarize merged PRs.',
};

const lookup = (id = SKILL._id, enabled = true) =>
  renderHook(() => useLoadedSkill(id, enabled)).result.current;

describe('useLoadedSkill', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockSkillQuery.mockReset();
    mockHasAccess.mockReturnValue(true);
    /** The server answers 404 for an id the user cannot open, which leaves no data. */
    mockSkillQuery.mockImplementation((id: string | undefined) => ({
      data: id === SKILL._id ? SKILL : undefined,
    }));
  });

  it('resolves the skill the call names by id and opens it', () => {
    const skill = lookup();

    expect(mockSkillQuery).toHaveBeenCalledWith(SKILL._id, { enabled: true });
    expect(skill?.instructions).toBe(SKILL.body);

    skill?.open();
    expect(mockNavigate).toHaveBeenCalledWith(`/skills/${SKILL._id}`);
  });

  it('resolves nothing for a skill the user cannot open or that was deleted', () => {
    expect(lookup('aaaaaaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
  });

  it('neither fetches nor resolves anything for a call without a skill id', () => {
    expect(lookup('')).toBeUndefined();
    expect(mockSkillQuery).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });

  it('neither fetches nor resolves the skill without skills access', () => {
    mockHasAccess.mockReturnValue(false);

    expect(lookup()).toBeUndefined();
    expect(mockSkillQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it('neither fetches nor resolves the skill while the lookup is off', () => {
    expect(lookup(SKILL._id, false)).toBeUndefined();
    expect(mockSkillQuery).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });
});
