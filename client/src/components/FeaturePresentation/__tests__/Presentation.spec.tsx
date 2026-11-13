import React, { useEffect, useState } from 'react';
import { Provider } from 'jotai';
import { Bot } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { resolveNavigation } from 'librechat-data-provider';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation, useParams } from 'react-router-dom';
import type { NavLink } from '~/common';
import { FeaturePresentationProvider, FeatureSlot, useFeaturePresentation } from '../Context';
import PresentationWorkspace from '../Workspace';
import FeaturePage from '../Page';

const labels = {
  Save: 'Save',
  Expand: 'Expand',
  Minimize: 'Minimize',
  Collapserail: 'Collapse rail',
  Openrail: 'Open rail',
  Openfeature: 'Open feature',
  Expandskills: 'Expand skills',
  Openskills: 'Open skills',
  Minimizeskills: 'Minimize skills',
  Resolveaccess: 'Resolve access',
  Changeaccount: 'Change account',
  Revokeaccess: 'Revoke access',
};

const links: NavLink[] = [{ id: 'agents', icon: Bot, title: 'com_sidepanel_agent_builder' }];
const mounts = jest.fn();
const unmounts = jest.fn();
const chatMounts = jest.fn();
const chatUnmounts = jest.fn();
const chatEffects = jest.fn();
const visibleObserver = jest.fn();
let finishSave: () => void;

function Editor({ visible }: { visible: boolean }) {
  const presentation = useFeaturePresentation()!;
  const {
    register,
    formState: { isDirty },
  } = useForm({ defaultValues: { name: 'Agent A' } });
  const [pending, setPending] = useState(false);
  const [section, setSection] = useState('instructions');
  const [agentId, setAgentId] = useState('explicit-agent');
  useEffect(() => {
    mounts();
    return () => {
      unmounts();
    };
  }, []);
  useEffect(() => {
    visibleObserver(visible);
  }, [visible]);
  return (
    <div>
      <input aria-label="Agent name" {...register('name')} />
      <input
        aria-label="Selected agent"
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
      />
      <button onClick={() => setSection('model')}>{section}</button>
      <output>{isDirty ? 'dirty' : 'clean'}</output>
      <output>{pending ? 'saving' : 'idle'}</output>
      <button
        onClick={() => {
          setPending(true);
          finishSave = () => setPending(false);
        }}
      >
        {labels.Save}
      </button>
      <button onClick={() => presentation.expand('agentBuilder')}>{labels.Expand}</button>
      <button onClick={() => presentation.minimize('agentBuilder')}>{labels.Minimize}</button>
    </div>
  );
}
const features = { agentBuilder: Editor };

function Chat() {
  const { conversationId } = useParams();
  const location = useLocation();
  useEffect(() => {
    chatMounts();
    return () => {
      chatUnmounts();
    };
  }, []);
  useEffect(() => {
    chatEffects(conversationId, location.pathname, location.search);
  }, [conversationId, location]);
  return (
    <main data-testid="live-chat">
      <output>{conversationId}</output>
      <input aria-label="Chat draft" defaultValue="unsent" />
      <input aria-label="Chat files" type="file" />
    </main>
  );
}

function Controls({ setVisible }: { setVisible: (visible: boolean) => void }) {
  const presentation = useFeaturePresentation()!;
  return (
    <>
      <button onClick={() => setVisible(false)}>{labels.Collapserail}</button>
      <button onClick={() => setVisible(true)}>{labels.Openrail}</button>
      <button onClick={() => presentation.open('agentBuilder')}>{labels.Openfeature}</button>
      <button onClick={() => presentation.expand('skills')}>{labels.Expandskills}</button>
      <button onClick={() => presentation.open('skills')}>{labels.Openskills}</button>
      <button onClick={() => presentation.minimize('skills')}>{labels.Minimizeskills}</button>
    </>
  );
}

function setup({
  entry = '/c/chat-a?projectId=abc&foo=bar',
  allowed = true,
  enabled = true,
  defaultView = 'panel' as 'page' | 'panel',
  panelInitiallyMounted = true,
  loading = false,
  includeSkills = false,
} = {}) {
  const panelOpen = jest.fn();
  const navigation = resolveNavigation({ pages: { agentBuilder: { enabled, defaultView } } });
  function Layout() {
    const [visible, setVisible] = useState(true);
    const [ready, setReady] = useState(!loading);
    const [account, setAccount] = useState('account-a');
    const [permitted, setPermitted] = useState(allowed);
    const availableLinks = includeSkills ? [...links, { ...links[0], id: 'skills' }] : links;
    return (
      <FeaturePresentationProvider
        key={account}
        ready={ready}
        links={ready && permitted ? availableLinks : []}
        features={includeSkills ? { ...features, skills: Editor } : features}
        navigation={navigation}
        onPanelOpen={panelOpen}
      >
        <button onClick={() => setReady(true)}>{labels.Resolveaccess}</button>
        <button onClick={() => setAccount('account-b')}>{labels.Changeaccount}</button>
        <button onClick={() => setPermitted(false)}>{labels.Revokeaccess}</button>
        <Controls setVisible={setVisible} />
        <aside hidden={!visible}>
          {panelInitiallyMounted && (
            <FeatureSlot page="agentBuilder" view="panel" visible={visible} />
          )}
        </aside>
        <PresentationWorkspace />
      </FeaturePresentationProvider>
    );
  }
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: '/c/:conversationId', element: <Chat /> },
          { path: '/agent-builder', element: <FeaturePage page="agentBuilder" /> },
          { path: '/skills', element: <FeaturePage page="skills" /> },
        ],
      },
    ],
    { initialEntries: [entry] },
  );
  const rendered = render(
    <Provider>
      <RouterProvider router={router} />
    </Provider>,
  );
  return { router, panelOpen, ...rendered };
}

beforeEach(() => jest.clearAllMocks());

describe('feature presentation lifetime', () => {
  it('keeps one dirty editor and one live chat through page/panel and rail changes', async () => {
    const { router, panelOpen } = setup();
    const name = await screen.findByLabelText('Agent name');
    const draft = screen.getByLabelText('Chat draft');
    const files = screen.getByLabelText('Chat files');
    const upload = new File(['attachment'], 'chat.txt');
    fireEvent.change(name, { target: { value: 'Unsaved agent' } });
    fireEvent.change(screen.getByLabelText('Selected agent'), {
      target: { value: 'selected-agent-b' },
    });
    fireEvent.change(draft, { target: { value: 'Unsent chat draft' } });
    fireEvent.change(files, { target: { files: [upload] } });
    fireEvent.click(screen.getByText('instructions'));
    fireEvent.click(screen.getByText('Save'));
    fireEvent.click(screen.getByText('Expand'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent-builder'));
    expect(screen.getByLabelText('Agent name')).toBe(name);
    expect(name).toHaveValue('Unsaved agent');
    expect(screen.getByText('dirty')).toBeInTheDocument();
    expect(screen.getByText('saving')).toBeInTheDocument();
    expect(screen.getByText('model')).toBeInTheDocument();
    expect(screen.getByLabelText('Selected agent')).toHaveValue('selected-agent-b');
    expect(screen.getAllByTestId('live-chat')).toHaveLength(1);
    expect(screen.getByTestId('live-chat')).not.toBeVisible();
    expect(screen.getByTestId('live-chat').closest('[inert]')).not.toBeNull();
    expect(chatEffects.mock.calls).toEqual([['chat-a', '/c/chat-a', '?projectId=abc&foo=bar']]);
    expect(chatMounts).toHaveBeenCalledTimes(1);
    expect(chatUnmounts).not.toHaveBeenCalled();
    act(() => finishSave());
    expect(screen.getByText('idle')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Minimize'));
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/c/chat-a?projectId=abc&foo=bar',
      ),
    );
    expect(panelOpen).toHaveBeenCalledWith('agents');
    expect(screen.getByLabelText('Chat draft')).toBe(draft);
    expect(draft).toHaveValue('Unsent chat draft');
    expect(screen.getByLabelText('Chat files')).toBe(files);
    expect((files as HTMLInputElement).files?.[0]).toBe(upload);
    expect(screen.getByLabelText('Agent name')).toBe(name);
    fireEvent.click(screen.getByText('Collapse rail'));
    await waitFor(() => expect(visibleObserver).toHaveBeenLastCalledWith(false));
    fireEvent.click(screen.getByText('Open rail'));
    await waitFor(() => expect(visibleObserver).toHaveBeenLastCalledWith(true));
    expect(name).toHaveValue('Unsaved agent');
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
    expect(chatUnmounts).not.toHaveBeenCalled();
  });

  it.each([{ allowed: false }, { enabled: false }])(
    'denies direct entry before mounting a consumer: %p',
    async (options) => {
      const { router } = setup({
        ...options,
        entry: '/agent-builder',
        panelInitiallyMounted: false,
      });
      await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
      expect(mounts).not.toHaveBeenCalled();
    },
  );

  it('waits for async config, roles, and endpoints before allowing or denying direct entry', async () => {
    const { router } = setup({
      entry: '/agent-builder',
      loading: true,
      panelInitiallyMounted: false,
    });
    expect(router.state.location.pathname).toBe('/agent-builder');
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(mounts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Resolve access'));
    await screen.findByLabelText('Agent name');
    expect(router.state.location.pathname).toBe('/agent-builder');
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it('clears the previous editor session on account change', async () => {
    setup();
    const name = await screen.findByLabelText('Agent name');
    fireEvent.change(name, { target: { value: 'Private draft' } });
    fireEvent.click(screen.getByText('Change account'));
    await waitFor(() => expect(screen.getByLabelText('Agent name')).toHaveValue('Agent A'));
    expect(screen.getByLabelText('Agent name')).not.toBe(name);
    expect(unmounts).toHaveBeenCalledTimes(1);
  });

  it('unmounts denied sessions even when the page is configured enabled', async () => {
    const { router } = setup();
    await screen.findByLabelText('Agent name');
    fireEvent.click(screen.getByText('Expand'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent-builder'));
    fireEvent.click(screen.getByText('Revoke access'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
    expect(screen.queryByLabelText('Agent name')).not.toBeInTheDocument();
    expect(unmounts).toHaveBeenCalledTimes(1);
  });

  it('uses c/new for a direct page entry without mounting a hidden chat', async () => {
    const { router } = setup({ entry: '/agent-builder' });
    await screen.findByLabelText('Agent name');
    expect(chatMounts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Minimize'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
    expect(chatMounts).toHaveBeenCalledTimes(1);
  });

  it('keeps the original chat URL when expanding another feature page', async () => {
    const { router } = setup({ includeSkills: true });
    await screen.findByLabelText('Agent name');
    fireEvent.click(screen.getByText('Expand'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent-builder'));
    fireEvent.click(screen.getByText('Expand skills'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/skills'));
    fireEvent.click(screen.getByText('Minimize skills'));
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/c/chat-a?projectId=abc&foo=bar',
      ),
    );
    expect(chatMounts).toHaveBeenCalledTimes(1);
    expect(chatUnmounts).not.toHaveBeenCalled();
  });

  it('opens a panel-default feature beside the originating chat when leaving a feature page', async () => {
    const { router, panelOpen } = setup({ includeSkills: true });
    await screen.findByLabelText('Agent name');
    fireEvent.click(screen.getByText('Expand'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent-builder'));
    fireEvent.click(screen.getByText('Open skills'));
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/c/chat-a?projectId=abc&foo=bar',
      ),
    );
    expect(panelOpen).toHaveBeenCalledWith('skills');
  });

  it('does not eagerly mount a feature without a page or panel request', () => {
    setup({ panelInitiallyMounted: false });
    expect(mounts).not.toHaveBeenCalled();
  });

  it('keeps current default activation in a panel', () => {
    const { router, panelOpen } = setup({ enabled: false });
    fireEvent.click(screen.getByText('Open feature'));
    expect(router.state.location.pathname).toBe('/c/chat-a');
    expect(panelOpen).toHaveBeenCalledWith('agents');
  });

  it('honors page-default activation only for an enabled and allowed page', async () => {
    const { router } = setup({ defaultView: 'page' });
    fireEvent.click(screen.getByText('Open feature'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent-builder'));
  });
});
