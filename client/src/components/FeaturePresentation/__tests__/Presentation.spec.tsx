import React, { useContext, useEffect, useState } from 'react';
import { Provider } from 'jotai';
import { Bot } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { resolveNavigation } from 'librechat-data-provider';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  useParams,
  useNavigate,
  UNSAFE_RouteContext,
} from 'react-router-dom';
import type { NavLink } from '~/common';
import { FeaturePresentationProvider, FeatureSlot, useFeaturePresentation } from '../Context';
import useUnifiedSidebarLinks from '~/hooks/Nav/useUnifiedSidebarLinks';
import useRevealChat from '~/hooks/Nav/useRevealChat';
import PresentationWorkspace from '../Workspace';
import ChatRouteOwner from '../Route';
import FeaturePage from '../Page';

let mockDrawer = false;
const mockSetSidebarOpen = jest.fn();
jest.mock('~/hooks/Nav/useDrawerViewport', () => ({ __esModule: true, default: () => mockDrawer }));
jest.mock('~/hooks/Nav/useSidebarToggle', () => ({
  __esModule: true,
  default: () => ({ setSidebarOpen: mockSetSidebarOpen }),
}));
jest.mock('~/components/Chat/Menus/OpenSidebar', () => () => null);

jest.mock('~/data-provider', () => ({ useGetStartupConfig: () => ({}) }));
jest.mock('~/hooks/Nav/useSideNavLinks', () => ({ useSideNavDestinations: jest.fn() }));
jest.mock('~/components/UnifiedSidebar/ConversationsSection', () => () => null);

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
let capturedNavigate: ReturnType<typeof useNavigate>;
let capturedDataRoute: boolean;

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
      <button onClick={() => presentation.minimize(presentation.page ?? 'agentBuilder')}>
        {labels.Minimize}
      </button>
    </div>
  );
}
const features = { agentBuilder: Editor };

function Chat() {
  const { conversationId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isDataRoute } = useContext(UNSAFE_RouteContext);
  useEffect(() => {
    capturedNavigate = navigate;
    capturedDataRoute = isDataRoute;
  }, [navigate, isDataRoute]);
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
  const navLinks = useUnifiedSidebarLinks();
  return (
    <>
      <button
        onClick={() =>
          navLinks
            .find((link) => link.id === 'assistants')
            ?.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
        }
      >
        {'Assistant Builder'}
      </button>
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
  includePrompts = false,
  basename = '',
  mobile = false,
} = {}) {
  mockDrawer = mobile;
  const panelOpen = jest.fn();
  const navigation = resolveNavigation({ pages: { agentBuilder: { enabled, defaultView } } });
  function Layout() {
    const revealPage = useRevealChat();
    const [visible, setVisible] = useState(true);
    const [ready, setReady] = useState(!loading);
    const [account, setAccount] = useState('account-a');
    const [permitted, setPermitted] = useState(allowed);
    const availableLinks = [...links, { ...links[0], id: 'assistants', Component: () => null }];
    if (includeSkills) availableLinks.push({ ...links[0], id: 'skills' });
    if (includePrompts) availableLinks.push({ ...links[0], id: 'prompts' });
    return (
      <FeaturePresentationProvider
        key={account}
        ready={ready}
        links={ready && permitted ? availableLinks : []}
        features={{
          ...features,
          ...(includeSkills ? { skills: Editor } : {}),
          ...(includePrompts ? { prompts: Editor } : {}),
        }}
        navigation={navigation}
        onPanelOpen={panelOpen}
        revealPage={revealPage}
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
          {
            path: '/c/:conversationId',
            element: (
              <ChatRouteOwner>
                <Chat />
              </ChatRouteOwner>
            ),
          },
          { path: '/login', element: <div>{'Login'}</div> },
          { path: '/agent-builder', element: <FeaturePage page="agentBuilder" /> },
          { path: '/skills', element: <FeaturePage page="skills" /> },
          { path: '/skills/:skillId', element: <div>{'Skill detail'}</div> },
          { path: '/skills/:skillId/edit', element: <div>{'Skill edit'}</div> },
          { path: '/prompts', element: <FeaturePage page="prompts" /> },
          { path: '/prompts/:promptId', element: <div>{'Prompt detail'}</div> },
        ],
      },
    ],
    { initialEntries: [basename + entry], basename: basename || '/' },
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
  it('adopts a saved background route under a non-root deployment basename', async () => {
    const { router } = setup({ entry: '/c/new?projectId=abc', basename: '/app' });
    const finalNavigate = capturedNavigate;
    expect(capturedDataRoute).toBe(true);
    const draft = screen.getByLabelText('Chat draft');
    fireEvent.click(await screen.findByText('Expand'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/agent-builder'));
    await act(async () => {
      await finalNavigate('/c/saved?projectId=abc', { replace: true });
    });
    expect(router.state.location.pathname).toBe('/app/agent-builder');
    expect(screen.getByTestId('live-chat')).toHaveTextContent('saved');
    fireEvent.click(screen.getByText('Minimize'));
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/app/c/saved?projectId=abc',
      ),
    );
    expect(screen.getByLabelText('Chat draft')).toBe(draft);
    expect(chatMounts).toHaveBeenCalledTimes(1);
    expect(chatUnmounts).not.toHaveBeenCalled();
  });

  it.each(['panel', 'page'] as const)(
    'reveals the mobile main pane before %s-default page navigation',
    async (defaultView) => {
      const { router, panelOpen } = setup({ mobile: true, defaultView });
      fireEvent.click(await screen.findByText(defaultView === 'page' ? 'Open feature' : 'Expand'));
      expect(mockSetSidebarOpen).toHaveBeenCalledWith(false, expect.any(Function));
      expect(router.state.location.pathname).toBe('/c/chat-a');
      await act(async () => {
        await mockSetSidebarOpen.mock.calls[0][1]();
      });
      await waitFor(() => expect(router.state.location.pathname).toBe('/agent-builder'));
      expect(panelOpen).not.toHaveBeenCalled();
    },
  );

  it('restores focused presentation controls after each visible portal move', async () => {
    const { router } = setup();
    const expand = await screen.findByText('Expand');
    expand.focus();
    fireEvent.click(expand);
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent-builder'));
    await waitFor(() => expect(expand).toHaveFocus());
    const minimize = screen.getByText('Minimize');
    minimize.focus();
    fireEvent.click(minimize);
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/chat-a'));
    await waitFor(() => expect(minimize).toHaveFocus());
    expect(mockSetSidebarOpen).not.toHaveBeenCalled();
  });

  it.each([
    { collection: '/skills', resource: '/skills/skill-a?file=README.md', includeSkills: true },
    { collection: '/skills', resource: '/skills/skill-a/edit', includeSkills: true },
    { collection: '/prompts', resource: '/prompts/prompt-a', includePrompts: true },
  ])('keeps the exact composer across $resource and back to the collection', async (options) => {
    const { router } = setup(options);
    const draft = screen.getByLabelText('Chat draft');
    fireEvent.change(draft, { target: { value: 'Memory-only draft' } });
    fireEvent.click(await screen.findByText('Expand'));
    await act(async () => {
      await router.navigate(options.collection);
    });
    await act(async () => {
      await router.navigate(options.resource);
    });
    expect(screen.getByLabelText('Chat draft')).toBe(draft);
    expect(screen.getByTestId('live-chat')).not.toBeVisible();
    const consumerCount = mounts.mock.calls.length;
    await act(async () => {
      await router.navigate(options.collection);
    });
    expect(mounts).toHaveBeenCalledTimes(consumerCount);
    fireEvent.click(screen.getAllByText('Minimize').at(-1)!);
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/c/chat-a?projectId=abc&foo=bar',
      ),
    );
    expect(screen.getByLabelText('Chat draft')).toBe(draft);
    expect(draft).toHaveValue('Memory-only draft');
    expect(chatMounts).toHaveBeenCalledTimes(1);
    expect(chatUnmounts).not.toHaveBeenCalled();
  });

  it('applies a first-turn final navigation captured before expansion to the retained data route', async () => {
    const { router } = setup({ entry: '/c/new?projectId=abc', includeSkills: true });
    const finalNavigate = capturedNavigate;
    expect(capturedDataRoute).toBe(true);
    const draft = screen.getByLabelText('Chat draft');
    fireEvent.click(await screen.findByText('Expand'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent-builder'));
    await act(async () => {
      await finalNavigate('/c/saved?projectId=abc', { replace: true });
    });
    expect(router.state.location.pathname).toBe('/agent-builder');
    expect(screen.getByTestId('live-chat')).toHaveTextContent('saved');
    expect(chatEffects).toHaveBeenLastCalledWith('saved', '/c/saved', '?projectId=abc');
    expect(chatUnmounts).not.toHaveBeenCalled();
    await act(async () => {
      await router.navigate('/skills/skill-a/edit');
    });
    await act(async () => {
      await finalNavigate('/c/retried', { replace: true });
    });
    expect(router.state.location.pathname).toBe('/skills/skill-a/edit');
    expect(screen.getByTestId('live-chat')).toHaveTextContent('retried');
    await act(async () => {
      await router.navigate('/agent-builder');
    });
    fireEvent.click(screen.getByText('Minimize'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/retried'));
    expect(screen.getByLabelText('Chat draft')).toBe(draft);
    expect(chatMounts).toHaveBeenCalledTimes(1);
    expect(chatUnmounts).not.toHaveBeenCalled();
  });

  it('does not intercept parent auth navigation from a captured chat callback', async () => {
    const { router } = setup({ entry: '/c/new' });
    const navigate = capturedNavigate;
    fireEvent.click(await screen.findByText('Expand'));
    await act(async () => {
      await navigate('/login');
    });
    expect(router.state.location.pathname).toBe('/login');
    expect(chatUnmounts).toHaveBeenCalledTimes(1);
  });

  it('restores the origin through the shared hook for unregistered Assistant Builder panels', async () => {
    const { router, panelOpen } = setup();
    fireEvent.click(await screen.findByText('Expand'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent-builder'));
    fireEvent.click(screen.getByText('Assistant Builder'));
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/c/chat-a?projectId=abc&foo=bar',
      ),
    );
    expect(panelOpen).toHaveBeenCalledWith('assistants');
  });

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
