import React, { useState } from 'react';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import {
  captureComposerDraft,
  bindComposerLaunch,
  adoptComposerConversation,
} from '~/utils/drafts';
import { useAutoSave } from '~/hooks/Input/useAutoSave';
import ProjectLandingChip from '../ProjectLandingChip';

const mockChatContext = React.createContext<{
  conversation: TConversation;
  setConversation: React.Dispatch<React.SetStateAction<TConversation>>;
} | null>(null);
const mockSetValue = jest.fn();
const mockProjects = [
  { _id: 'project-a', name: 'Project A' },
  { _id: 'project-b', name: 'Project B' },
];

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: () => jest.fn(),
}));
jest.mock('~/store', () => ({ ephemeralAgentByConvoId: (id: string) => id }));
jest.mock('~/Providers', () => ({
  useChatContext: () => jest.requireActual('react').useContext(mockChatContext),
  useChatFormContext: () => ({ setValue: mockSetValue }),
}));
jest.mock('~/hooks/Files/useFileHandling', () => ({ hasInFlightUpload: () => false }));
jest.mock('~/utils', () => jest.requireActual('~/utils/drafts'));
jest.mock('~/Providers/ChatSettingsContext', () => ({
  useChatSettings: () => ({ saveDrafts: false }),
}));
jest.mock('~/data-provider', () => ({
  useGetFiles: () => ({ data: [] }),
  useProjectsInfiniteQuery: () => ({ data: { pages: [{ projects: mockProjects }] } }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('@librechat/client', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ControlCombobox: ({
      selectedValue,
      setValue,
      ariaLabel,
      items,
    }: {
      selectedValue: string;
      setValue: (value: string) => void;
      ariaLabel: string;
      items: Array<{ value: string; label: string }>;
    }) =>
      React.createElement(
        'select',
        {
          'aria-label': ariaLabel,
          value: selectedValue,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setValue(event.target.value),
        },
        items.map((item) =>
          React.createElement('option', { key: item.value, value: item.value }, item.label),
        ),
      ),
    TooltipAnchor: ({ render: control }: { render: React.ReactNode }) => control,
  };
});

function mountProjectComposer() {
  const api: { setSubmitting: (value: boolean) => void } = { setSubmitting: () => undefined };
  function Harness() {
    const location = useLocation();
    const [conversation, setConversation] = useState<TConversation>({
      conversationId: 'new',
      chatProjectId: 'project-a',
      title: 'New Chat',
    } as TConversation);
    const [isSubmitting, setSubmitting] = useState(false);
    const [files, setFiles] = useState<Map<string, ExtendedFile>>(new Map());
    api.setSubmitting = setSubmitting;
    useAutoSave({ index: 3, conversationId: 'new', isSubmitting, files, setFiles });
    const project = mockProjects.find(({ _id }) => _id === conversation.chatProjectId);
    return (
      <mockChatContext.Provider value={{ conversation, setConversation }}>
        <output aria-label="Current route">{location.pathname + location.search}</output>
        {project && (
          <ProjectLandingChip
            project={project as Parameters<typeof ProjectLandingChip>[0]['project']}
          />
        )}
      </mockChatContext.Provider>
    );
  }
  return {
    ...render(
      <BrowserRouter>
        <Harness />
      </BrowserRouter>,
    ),
    api,
  };
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/c/new?projectId=project-a');
});

afterEach(() => window.history.replaceState({}, '', '/'));

it.each(['remove', 'replace'])(
  'starts a fresh scope after the project chip changes the route (%s)',
  (action) => {
    const view = mountProjectComposer();
    const previous = captureComposerDraft(3, 'new');
    const previousLaunch = { conversationId: 'new' };
    bindComposerLaunch(previousLaunch, 3);
    if (action === 'remove') {
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_remove_from_project' }));
    } else {
      fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_change_project' }), {
        target: { value: 'project-b' },
      });
    }
    expect(screen.getByLabelText('Current route').textContent).toBe(
      action === 'remove' ? '/c/new' : '/c/new?projectId=project-b',
    );
    expect(previous()).toBe(false);
    const current = captureComposerDraft(3, 'new');
    expect(current()).toBe(true);
    expect(adoptComposerConversation(previousLaunch, 'stale-project-chat', 3)).toBe(false);
    const launch = { conversationId: 'new' };
    bindComposerLaunch(launch, 3);
    act(() => view.api.setSubmitting(true));
    expect(current()).toBe(true);
    expect(adoptComposerConversation(launch, 'current-project-chat', 3)).toBe(true);
    expect(current.conversationId()).toBe('current-project-chat');
    view.unmount();
  },
);

it('keeps ownership when the project selection does not change the route', () => {
  const view = mountProjectComposer();
  const captured = captureComposerDraft(3, 'new');
  fireEvent.change(screen.getByRole('combobox', { name: 'com_ui_change_project' }), {
    target: { value: 'project-a' },
  });
  expect(captured()).toBe(true);
  view.unmount();
});
