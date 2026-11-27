import { getDefaultStore } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import { isSubmittingFamily, useIsSubmitting, resetSubmitting } from '@librechat/chat/react';
import type { ReactNode } from 'react';
import store from '~/store';

const jotaiStore = getDefaultStore();
const wrapper = ({ children }: { children: ReactNode }) => <RecoilRoot>{children}</RecoilRoot>;

afterEach(() => {
  resetSubmitting(jotaiStore);
});

describe('useIsSubmitting beside a Recoil atom', () => {
  it('never commits the new Recoil text with the previous generating flag', () => {
    jotaiStore.set(isSubmittingFamily(0), true);
    const commits: Array<{ text: string; submitting: boolean }> = [];
    const { result } = renderHook(
      () => {
        const prompt = useRecoilValue(store.activePromptByIndex(0));
        const submitting = useIsSubmitting(0);
        commits.push({ text: prompt ?? '', submitting });
        return useSetRecoilState(store.activePromptByIndex(0));
      },
      { wrapper },
    );

    act(() => {
      jotaiStore.set(isSubmittingFamily(0), false);
      result.current('next');
    });

    const withNewText = commits.filter(({ text }) => text === 'next');
    expect(withNewText.length).toBeGreaterThan(0);
    expect(withNewText.every(({ submitting }) => !submitting)).toBe(true);
  });
});
