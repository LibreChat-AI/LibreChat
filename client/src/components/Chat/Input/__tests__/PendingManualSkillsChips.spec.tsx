import React from 'react';
import userEvent from '@testing-library/user-event';
import { RecoilRoot, MutableSnapshot } from 'recoil';
import { render, screen } from '@testing-library/react';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, params?: Record<string, unknown>) =>
    `${key}:${params?.[0] ?? ''}`,
}));

import PendingManualSkillsChips from '../PendingManualSkillsChips';
import store from '~/store';

const CONVO_ID = 'convo-1';

const renderWithSkills = (initialSkills: string[]) => {
  const initializeState = (snapshot: MutableSnapshot) => {
    snapshot.set(store.pendingManualSkillsByConvoId(CONVO_ID), initialSkills);
  };
  return render(
    <RecoilRoot initializeState={initializeState}>
      <PendingManualSkillsChips conversationId={CONVO_ID} />
    </RecoilRoot>,
  );
};

describe('PendingManualSkillsChips', () => {
  it('renders nothing when no skills are queued', () => {
    const { container } = renderWithSkills([]);
    expect(container.firstChild).toBeNull();
  });

  it('renders one chip per queued skill', () => {
    const { container } = renderWithSkills(['brand-guidelines', 'pptx']);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('brand-guidelines');
    expect(items[1]).toHaveTextContent('pptx');
    expect(container.querySelector('svg')).toHaveClass('text-status-info');
  });

  it('removes the chip when its × button is clicked', async () => {
    const user = userEvent.setup();
    renderWithSkills(['brand-guidelines', 'pptx']);
    const removeBrand = screen.getByRole('button', {
      name: 'com_ui_remove_skill_var:brand-guidelines',
    });
    await user.click(removeBrand);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('pptx');
  });

  it('clears the list when every chip is dismissed', async () => {
    const user = userEvent.setup();
    const { container } = renderWithSkills(['a']);
    await user.click(screen.getByRole('button', { name: 'com_ui_remove_skill_var:a' }));
    expect(container.firstChild).toBeNull();
  });
});
