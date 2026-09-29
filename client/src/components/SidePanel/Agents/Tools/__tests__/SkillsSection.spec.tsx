import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { SkillsScope } from 'librechat-data-provider';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { TSkillSummary } from 'librechat-data-provider';
import type { AgentItem } from '../items/types';
import SkillsSection from '../SkillsSection';

let mockFormValues: Record<string, unknown> = {};
const mockSetValue = jest.fn();
const mockUseSkillsInfiniteQuery = jest.fn();
/** Every fixture skill is runtime-active unless a test says otherwise. */
const mockIsActive = jest.fn((_skill: { _id: string }) => true);
const mockRefetchStates = jest.fn();
let mockStatesResult: { isLoading: boolean; isError: boolean };

let mockInfiniteResult: {
  data: { pages: Array<{ skills: TSkillSummary[] }> };
  fetchNextPage: jest.Mock;
  refetch: jest.Mock;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
};

jest.mock('react-hook-form', () => ({
  useFormContext: () => ({
    control: {},
    getValues: (name: string) => mockFormValues[name],
    setValue: mockSetValue,
  }),
  useWatch: ({ name }: { name: string }) => mockFormValues[name],
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { id: 'user-1' } }),
  useSkillActiveState: () => ({
    isActive: (skill: { _id: string }) => mockIsActive(skill),
    isLoading: mockStatesResult.isLoading,
    isError: mockStatesResult.isError,
    refetch: mockRefetchStates,
  }),
}));

jest.mock('~/data-provider', () => ({
  useSkillsInfiniteQuery: (...args: unknown[]) => mockUseSkillsInfiniteQuery(...args),
}));

function makeSkill(id: string, name: string): TSkillSummary {
  return {
    _id: id,
    name,
    description: `${name} description`,
    author: 'user-1',
    authorName: 'Test User',
    version: 1,
    source: 'inline',
    fileCount: 0,
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

function makeItem(id: string, name: string): AgentItem {
  const skill = makeSkill(id, name);
  return {
    kind: 'skill',
    id,
    name,
    description: skill.description ?? '',
    iconKey: 'skill',
    skill,
  };
}

function setAvailableSkills(pages: TSkillSummary[][]) {
  mockInfiniteResult = {
    data: { pages: pages.map((skills) => ({ skills })) },
    fetchNextPage: jest.fn(),
    refetch: jest.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isError: false,
  };
}

type Callbacks = {
  onInfo: (item: AgentItem) => void;
  onRemove: (item: AgentItem) => void;
  onAdd: () => void;
};

function renderSection(items: AgentItem[] = [], callbacks?: Partial<Callbacks>) {
  const props = {
    items,
    onInfo: callbacks?.onInfo ?? jest.fn(),
    onRemove: callbacks?.onRemove ?? jest.fn(),
    onAdd: callbacks?.onAdd ?? jest.fn(),
  };
  return render(<SkillsSection {...props} />);
}

function getRadio(label: string) {
  return screen.getByRole('radio', { name: label });
}

function expectNoFieldWrite(field: string) {
  expect(mockSetValue.mock.calls.some(([name]) => name === field)).toBe(false);
}

beforeEach(() => {
  mockFormValues = {};
  mockSetValue.mockClear();
  mockUseSkillsInfiniteQuery.mockClear();
  mockIsActive.mockReset();
  mockIsActive.mockReturnValue(true);
  mockRefetchStates.mockClear();
  mockStatesResult = { isLoading: false, isError: false };
  setAvailableSkills([]);
  mockUseSkillsInfiniteQuery.mockImplementation(() => mockInfiniteResult);
});

describe('SkillsSection mode derivation', () => {
  test.each([
    ['false', false],
    ['undefined', undefined],
  ])('checks Off and renders no body when skills_enabled is %s', (_label, enabled) => {
    mockFormValues = {
      skills_enabled: enabled,
      skills_scope: SkillsScope.selected,
      skills: ['s1'],
    };

    renderSection([makeItem('s1', 'Selected skill')]);

    expect(getRadio('com_ui_skills_mode_off')).toHaveAttribute('aria-checked', 'true');
    // Both bodies stay mounted so mode switches can tween; the inactive one is
    // inert and aria-hidden, so nothing in it is reachable.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_skills_add_row' })).not.toBeInTheDocument();
  });

  test('checks All for an explicitly all-scoped agent', () => {
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(getRadio('com_ui_skills_mode_all')).toHaveAttribute('aria-checked', 'true');
  });

  test('checks Selected for an explicitly selected-scoped agent', () => {
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.selected, skills: ['s1'] };

    renderSection([makeItem('s1', 'Selected skill')]);

    expect(getRadio('com_ui_skills_mode_selected')).toHaveAttribute('aria-checked', 'true');
  });

  test('uses All for a legacy enabled agent with an empty allowlist', () => {
    mockFormValues = { skills_enabled: true, skills: [] };

    renderSection();

    expect(getRadio('com_ui_skills_mode_all')).toHaveAttribute('aria-checked', 'true');
  });

  test('uses Selected for a legacy enabled agent with an allowlist', () => {
    mockFormValues = { skills_enabled: true, skills: ['s1'] };

    renderSection([makeItem('s1', 'Selected skill')]);

    expect(getRadio('com_ui_skills_mode_selected')).toHaveAttribute('aria-checked', 'true');
  });

  test('normalizes an ambiguous legacy scope without dirtying the form', () => {
    mockFormValues = { skills_enabled: true, skills: ['s1'] };

    renderSection([makeItem('s1', 'Selected skill')]);

    expect(mockSetValue).toHaveBeenCalledWith('skills_scope', SkillsScope.selected, {
      shouldDirty: false,
    });
  });

  test('clears authoring left on under a resolved Off', () => {
    /** `skillDeps` enables the authoring tools for either flag, so this shape
     *  would run with skills the section reports as disabled. */
    mockFormValues = {
      skills_enabled: false,
      skill_authoring_enabled: true,
      skills_scope: SkillsScope.none,
      skills: ['s1'],
    };

    renderSection([makeItem('s1', 'Selected skill')]);

    expect(getRadio('com_ui_skills_mode_off')).toHaveAttribute('aria-checked', 'true');
    expect(mockSetValue).toHaveBeenCalledWith('skill_authoring_enabled', false, {
      shouldDirty: false,
    });
  });

  test('leaves authoring alone while skills are enabled', () => {
    mockFormValues = {
      skills_enabled: true,
      skill_authoring_enabled: true,
      skills_scope: SkillsScope.all,
      skills: [],
    };

    renderSection();

    expect(getRadio('com_ui_skills_mode_all')).toHaveAttribute('aria-checked', 'true');
    expectNoFieldWrite('skill_authoring_enabled');
  });

  test('clears the master flag when an explicit none scope resolves to Off', () => {
    /** A valid API shape: enabled with `skills_scope: none`. The section shows
     *  Off, but `skillDeps` reads the master flag alone as permission to
     *  expose the authoring tools, and clicking Off cannot clear it. */
    mockFormValues = {
      skills_enabled: true,
      skills_scope: SkillsScope.none,
      skills: ['s1'],
    };

    renderSection([makeItem('s1', 'Selected skill')]);

    expect(getRadio('com_ui_skills_mode_off')).toHaveAttribute('aria-checked', 'true');
    expect(mockSetValue).toHaveBeenCalledWith('skills_enabled', false, { shouldDirty: false });
  });

  test('leaves the master flag alone while a catalog mode is active', () => {
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(getRadio('com_ui_skills_mode_all')).toHaveAttribute('aria-checked', 'true');
    expectNoFieldWrite('skills_enabled');
  });
});

describe('SkillsSection mode writes', () => {
  test('clicking All from Off enables skills without changing the allowlist', () => {
    mockFormValues = { skills: ['s1'], skills_enabled: false, skills_scope: SkillsScope.none };

    renderSection([makeItem('s1', 'Selected skill')]);
    fireEvent.click(getRadio('com_ui_skills_mode_all'));

    expect(mockSetValue).toHaveBeenCalledWith('skills_enabled', true, { shouldDirty: true });
    expect(mockSetValue).toHaveBeenCalledWith('skills_scope', SkillsScope.all, {
      shouldDirty: true,
    });
    expectNoFieldWrite('skills');
  });

  test('clicking Off disables skills and skill authoring', () => {
    mockFormValues = {
      skills: ['s1'],
      skills_enabled: true,
      skills_scope: SkillsScope.selected,
      skill_authoring_enabled: true,
    };

    renderSection([makeItem('s1', 'Selected skill')]);
    fireEvent.click(getRadio('com_ui_skills_mode_off'));

    expect(mockSetValue).toHaveBeenCalledWith('skills_enabled', false, { shouldDirty: true });
    expect(mockSetValue).toHaveBeenCalledWith('skills_scope', SkillsScope.none, {
      shouldDirty: true,
    });
    expect(mockSetValue).toHaveBeenCalledWith('skill_authoring_enabled', false, {
      shouldDirty: true,
    });
  });

  test('clicking Selected enables skills without changing the allowlist', () => {
    mockFormValues = { skills: ['s1'], skills_enabled: false, skills_scope: SkillsScope.none };

    renderSection([makeItem('s1', 'Selected skill')]);
    fireEvent.click(getRadio('com_ui_skills_mode_selected'));

    expect(mockSetValue).toHaveBeenCalledWith('skills_enabled', true, { shouldDirty: true });
    expect(mockSetValue).toHaveBeenCalledWith('skills_scope', SkillsScope.selected, {
      shouldDirty: true,
    });
    expectNoFieldWrite('skills');
  });

  test('round-tripping through All preserves the prior selection', () => {
    mockFormValues = { skills: ['s1'], skills_enabled: true, skills_scope: SkillsScope.selected };
    const { rerender } = renderSection([makeItem('s1', 'Selected skill')]);

    fireEvent.click(getRadio('com_ui_skills_mode_all'));
    expectNoFieldWrite('skills');

    mockFormValues = { skills: ['s1'], skills_enabled: true, skills_scope: SkillsScope.all };
    rerender(
      <SkillsSection
        items={[makeItem('s1', 'Selected skill')]}
        onInfo={jest.fn()}
        onRemove={jest.fn()}
        onAdd={jest.fn()}
      />,
    );
    mockSetValue.mockClear();
    fireEvent.click(getRadio('com_ui_skills_mode_selected'));

    expect(mockSetValue).toHaveBeenCalledWith('skills_enabled', true, { shouldDirty: true });
    expect(mockSetValue).toHaveBeenCalledWith('skills_scope', SkillsScope.selected, {
      shouldDirty: true,
    });
    expectNoFieldWrite('skills');
  });

  test('clicking the active segment writes nothing', () => {
    mockFormValues = { skills: [], skills_enabled: true, skills_scope: SkillsScope.all };

    renderSection();
    fireEvent.click(getRadio('com_ui_skills_mode_all'));

    expect(mockSetValue).not.toHaveBeenCalled();
  });

  test('re-enables an agent whose disabled state kept a stale scope', () => {
    /** Produced by the old Off handler, which never rewrote `skills_scope`.
     *  The section resolves it to Off, so clicking the retained scope has to
     *  write, not match the raw field and no-op while `Radio` moves anyway. */
    mockFormValues = { skills: [], skills_enabled: false, skills_scope: SkillsScope.all };

    renderSection();
    expect(getRadio('com_ui_skills_mode_off')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(getRadio('com_ui_skills_mode_all'));

    expect(mockSetValue).toHaveBeenCalledWith('skills_enabled', true, { shouldDirty: true });
    expect(mockSetValue).toHaveBeenCalledWith('skills_scope', SkillsScope.all, {
      shouldDirty: true,
    });
  });

  test('arrow keys move the checked radio and write the next scope', () => {
    mockFormValues = { skills: [], skills_enabled: false, skills_scope: SkillsScope.none };

    renderSection();
    fireEvent.keyDown(getRadio('com_ui_skills_mode_off'), { key: 'ArrowRight' });

    expect(mockSetValue).toHaveBeenCalledWith('skills_enabled', true, { shouldDirty: true });
    expect(mockSetValue).toHaveBeenCalledWith('skills_scope', SkillsScope.all, {
      shouldDirty: true,
    });
    expect(getRadio('com_ui_skills_mode_all')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('SkillsSection All mode body', () => {
  test('renders the plural available count from paginated skills', () => {
    setAvailableSkills([[makeSkill('s1', 'First skill')], [makeSkill('s2', 'Second skill')]]);
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(screen.getByText('com_ui_skills_available_count')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_skills_available_count_one')).not.toBeInTheDocument();
  });

  test('uses the singular available count for one skill', () => {
    setAvailableSkills([[makeSkill('s1', 'Only skill')]]);
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(screen.getByText('com_ui_skills_available_count_one')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_skills_available_count')).not.toBeInTheDocument();
  });

  test('expands the available skills list from its header button', () => {
    setAvailableSkills([[makeSkill('s1', 'First skill')], [makeSkill('s2', 'Second skill')]]);
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();
    const header = screen.getByRole('button', { name: /com_ui_skills_available_count/ });

    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveAttribute('aria-controls', 'skills-all-list');
    fireEvent.click(header);

    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('#skills-all-list')).toBeInTheDocument();
    expect(screen.getByText('First skill')).toBeInTheDocument();
    expect(screen.getByText('Second skill')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /com_ui_skills_remove/ })).not.toBeInTheDocument();
  });

  test('opens details from an available skill row, which is never removable', () => {
    setAvailableSkills([[makeSkill('s1', 'First skill')]]);
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };
    const onInfo = jest.fn();

    renderSection([], { onInfo });
    fireEvent.click(screen.getByRole('button', { name: /com_ui_skills_available_count/ }));
    fireEvent.click(screen.getByRole('button', { name: 'First skill' }));

    expect(onInfo).toHaveBeenCalledTimes(1);
    expect(onInfo.mock.calls[0][0]).toMatchObject({ id: 's1', name: 'First skill' });
    expect(screen.queryByRole('button', { name: /com_ui_skills_remove/ })).not.toBeInTheDocument();
  });

  test('reports what is loaded, not a lower bound, while more pages remain', () => {
    /** `hasNextPage` tracks raw pagination and the rows are filtered to the
     *  active ones, so the remaining pages may add nothing. Claiming "+ more
     *  available" would overstate the catalog in that case. */
    setAvailableSkills([[makeSkill('s1', 'First skill')]]);
    mockInfiniteResult.hasNextPage = true;
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(screen.getByText('com_ui_skills_available_count_loaded_one')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_skills_available_count')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_skills_available_count_one')).not.toBeInTheDocument();
  });

  test('uses the plural loaded phrasing for several loaded skills', () => {
    setAvailableSkills([[makeSkill('s1', 'First skill'), makeSkill('s2', 'Second skill')]]);
    mockInfiniteResult.hasNextPage = true;
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(screen.getByText('com_ui_skills_available_count_loaded')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_skills_available_count_loaded_one')).not.toBeInTheDocument();
  });

  test('leaves the rest of the catalog unfetched until the list is expanded', () => {
    setAvailableSkills([[makeSkill('s1', 'First skill')]]);
    mockInfiniteResult.hasNextPage = true;
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(mockInfiniteResult.fetchNextPage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /com_ui_skills_available_count/ }));

    expect(mockInfiniteResult.fetchNextPage).toHaveBeenCalled();
  });

  test('reports a failed catalog request instead of an empty one', () => {
    setAvailableSkills([]);
    mockInfiniteResult.isError = true;
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_skills_load_error');
    expect(screen.queryByText('com_ui_skills_available_count')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /com_ui_skills_available_count/ }),
    ).not.toBeInTheDocument();
  });

  test('retries the catalog request from the error state', () => {
    setAvailableSkills([]);
    mockInfiniteResult.isError = true;
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));

    expect(mockInfiniteResult.refetch).toHaveBeenCalledTimes(1);
  });

  test('reports loading rather than an empty catalog before the first page lands', () => {
    setAvailableSkills([]);
    mockInfiniteResult.data = undefined as never;
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_skills_available_count')).not.toBeInTheDocument();
  });

  test('counts and lists only the skills the runtime would inject', () => {
    /** The list endpoint returns everything the user can VIEW; a shared skill
     *  left inactive is not part of the agent's catalog. */
    setAvailableSkills([[makeSkill('s1', 'Active skill'), makeSkill('s2', 'Inactive skill')]]);
    mockIsActive.mockImplementation((skill: { _id: string }) => skill._id === 's1');
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(screen.getByText('com_ui_skills_available_count_one')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /com_ui_skills_available_count/ }));

    expect(screen.getByText('Active skill')).toBeInTheDocument();
    expect(screen.queryByText('Inactive skill')).not.toBeInTheDocument();
  });

  test('waits for the skill states before describing the catalog', () => {
    /** The hook reports every skill active until the overrides land, so a
     *  count taken then could list a deactivated skill as available. */
    setAvailableSkills([[makeSkill('s1', 'First skill')]]);
    mockStatesResult = { isLoading: true, isError: false };
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_skills_available_count_one')).not.toBeInTheDocument();
  });

  test('reports an error when the skill states fail, not an unfiltered count', () => {
    setAvailableSkills([[makeSkill('s1', 'First skill')]]);
    mockStatesResult = { isLoading: false, isError: true };
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_skills_load_error');
    expect(
      screen.queryByRole('button', { name: /com_ui_skills_available_count/ }),
    ).not.toBeInTheDocument();
  });

  test('retries both the catalog and the skill states', () => {
    setAvailableSkills([]);
    mockInfiniteResult.isError = true;
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));

    expect(mockInfiniteResult.refetch).toHaveBeenCalledTimes(1);
    expect(mockRefetchStates).toHaveBeenCalledTimes(1);
  });
});

describe('SkillsSection Selected mode body', () => {
  test('renders one removable row per selected item and removes the clicked item', () => {
    const first = makeItem('s1', 'First skill');
    const second = makeItem('s2', 'Second skill');
    const onRemove = jest.fn();
    mockFormValues = {
      skills_enabled: true,
      skills_scope: SkillsScope.selected,
      skills: ['s1', 's2'],
    };

    renderSection([first, second], { onRemove });

    const removeButtons = screen.getAllByRole('button', { name: 'com_ui_skills_remove' });
    expect(removeButtons).toHaveLength(2);
    fireEvent.click(removeButtons[1]);

    expect(onRemove).toHaveBeenCalledWith(second);
  });

  test('opens item details when a selected row name is clicked', () => {
    const item = makeItem('s1', 'Selected skill');
    const onInfo = jest.fn();
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.selected, skills: ['s1'] };

    renderSection([item], { onInfo });
    fireEvent.click(screen.getByRole('button', { name: 'Selected skill' }));

    expect(onInfo).toHaveBeenCalledWith(item);
  });

  test('moves Add into the header, before the mode control, once rows exist', () => {
    const items = [makeItem('s1', 'First skill'), makeItem('s2', 'Second skill')];
    const onAdd = jest.fn();
    mockFormValues = {
      skills_enabled: true,
      skills_scope: SkillsScope.selected,
      skills: ['s1', 's2'],
    };

    renderSection(items, { onAdd });

    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    // Exactly one Add affordance, and it is the header button rather than the
    // dashed empty-state card.
    const add = screen.getByRole('button', { name: /com_ui_skills_add_row/ });
    expect(add).not.toHaveTextContent('com_ui_skills_add_row');
    expect(
      add.compareDocumentPosition(screen.getByRole('radiogroup')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(add.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  test('has no header Add button while the selection is empty', () => {
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.selected, skills: [] };

    renderSection([]);

    // The only affordance is the dashed card, identified by its visible text.
    const add = screen.getByRole('button', { name: /com_ui_skills_add_row/ });
    expect(add).toHaveTextContent('com_ui_skills_add_row');
  });

  test('renders only the Add card, with its hint, when no skills are selected', () => {
    const onAdd = jest.fn();
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.selected, skills: [] };

    renderSection([], { onAdd });

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    const add = screen.getByRole('button', { name: /com_ui_skills_add_row/ });
    expect(add).toHaveTextContent('com_ui_skills_empty_hint');
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  test('drops the Add card hint once something is selected', () => {
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.selected, skills: ['s1'] };

    renderSection([makeItem('s1', 'First skill')]);

    expect(screen.getByRole('button', { name: /com_ui_skills_add_row/ })).not.toHaveTextContent(
      'com_ui_skills_empty_hint',
    );
  });

  test('has exactly one Add affordance in Selected and none in Off or All', () => {
    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.selected, skills: [] };
    const { rerender } = renderSection();

    expect(screen.getAllByRole('button', { name: /com_ui_skills_add_row/ })).toHaveLength(1);

    mockFormValues = { skills_enabled: false, skills_scope: SkillsScope.none, skills: [] };
    rerender(
      <SkillsSection items={[]} onInfo={jest.fn()} onRemove={jest.fn()} onAdd={jest.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /com_ui_skills_add_row/ })).not.toBeInTheDocument();

    mockFormValues = { skills_enabled: true, skills_scope: SkillsScope.all, skills: [] };
    rerender(
      <SkillsSection items={[]} onInfo={jest.fn()} onRemove={jest.fn()} onAdd={jest.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /com_ui_skills_add_row/ })).not.toBeInTheDocument();
  });
});

describe('SkillsSection accessibility', () => {
  test('exposes one radiogroup with exactly three radio segments', () => {
    mockFormValues = { skills_enabled: false, skills_scope: SkillsScope.none, skills: [] };

    renderSection();

    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-labelledby', 'skills-mode-label');
  });
});
