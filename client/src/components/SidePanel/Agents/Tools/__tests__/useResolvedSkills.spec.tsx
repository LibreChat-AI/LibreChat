import React from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TSkillSummary } from 'librechat-data-provider';
import { makeSkill } from 'test/itemFactories';
import { useResolvedSkills } from '../hooks';

const mockGetSkill = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSkill: (id: string) => mockGetSkill(id),
    },
  };
});

jest.mock('librechat-data-provider/react-query', () => ({
  useUpdateUserPluginsMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useHasMemoryAccess: () => true,
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { id: 'u1' } }),
}));

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({}),
}));

jest.mock('~/data-provider', () => ({
  useVerifyAgentToolAuth: () => ({ data: undefined }),
}));

function makeWrapper(skillIds: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    const methods = useForm({ defaultValues: { skills: skillIds } });
    return (
      <QueryClientProvider client={queryClient}>
        <FormProvider {...methods}>{children}</FormProvider>
      </QueryClientProvider>
    );
  };
}

function renderResolvedSkills(
  skillIds: string[],
  pageSkills?: TSkillSummary[],
  resolveAllowlist = true,
) {
  return renderHook(
    (props: TSkillSummary[] | undefined) => useResolvedSkills(props, resolveAllowlist),
    {
      wrapper: makeWrapper(skillIds),
      initialProps: pageSkills,
    },
  );
}

describe('useResolvedSkills', () => {
  beforeEach(() => {
    mockGetSkill.mockReset();
  });

  test('returns undefined while the catalog page has not loaded', () => {
    const { result } = renderResolvedSkills(['s1']);
    expect(result.current).toBeUndefined();
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  test('passes the page through untouched when every allowlist id is on it', () => {
    const page = [makeSkill({ _id: 's1' }), makeSkill({ _id: 's2' })];
    const { result } = renderResolvedSkills(['s1', 's2'], page);
    expect(result.current).toBe(page);
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  test('resolves an allowlist id missing from the page individually and appends it', async () => {
    const page = [makeSkill({ _id: 's1' })];
    const offPage = makeSkill({ _id: 'off-page', name: 'Off Page Skill' });
    mockGetSkill.mockResolvedValue(offPage);

    const { result } = renderResolvedSkills(['s1', 'off-page'], page);

    await waitFor(() => {
      expect(result.current?.map((skill) => skill._id)).toEqual(['s1', 'off-page']);
    });
    expect(mockGetSkill).toHaveBeenCalledWith('off-page');
    expect(result.current?.[1].name).toBe('Off Page Skill');
  });

  test('skips the per-id lookups when the caller is not rendering allowlist rows', () => {
    /** Off and All keep the allowlist but never show it, so resolving ids the
     *  first page missed would be one request each for a list nobody sees. */
    const page = [makeSkill({ _id: 's1' })];
    const { result } = renderResolvedSkills(['s1', 'off-page'], page, false);

    expect(result.current).toBe(page);
    expect(mockGetSkill).not.toHaveBeenCalled();
  });

  test('keeps a confirmed miss (404) visible under a placeholder name', async () => {
    mockGetSkill.mockRejectedValue({ response: { status: 404 } });

    const { result } = renderResolvedSkills(['gone'], []);

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current?.[0]._id).toBe('gone');
    expect(result.current?.[0].name).toBe('com_ui_skill_unavailable');
  });

  test('keeps a transient lookup error visible under the same placeholder', async () => {
    mockGetSkill.mockRejectedValue({ response: { status: 500 } });

    const { result } = renderResolvedSkills(['flaky'], []);

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current?.[0]._id).toBe('flaky');
    expect(result.current?.[0].name).toBe('com_ui_skill_unavailable');
  });
});
