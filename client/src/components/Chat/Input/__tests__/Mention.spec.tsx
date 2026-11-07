import React from 'react';
import { atom, RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import Mention from '../Mention';

const mockSelectModel = jest.fn();
const mockSelectServer = jest.fn();
const mockRefresh = jest.fn();
const mockRefetch = jest.fn();
const modelOptions = [{ type: 'model', value: 'openAI', label: 'Example model' }];
const servers = [
  { serverName: 'github', config: { title: 'Repository tools' } },
  { serverName: 'gitlab', config: { title: 'Repository tools' } },
];
const makeManager = () => ({
  availableMCPServers: servers,
  selectableServers: servers,
  mcpValues: ['github'],
  connectionStatus: { github: { connectionState: 'connected' } },
  isInitializing: () => false,
  isLoading: false,
  isCatalogError: false,
  refetchServers: mockRefetch,
  selectServer: mockSelectServer,
});
let mockContext = { mcpServerManager: makeManager() };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGetConversation: () => jest.fn(),
}));
jest.mock('~/hooks/useLocalize', () => ({ __esModule: true, default: () => (key: string) => key }));
jest.mock('~/Providers', () => ({ useAssistantsMapContext: () => ({}) }));
jest.mock('~/Providers/BadgeRowContext', () => ({ useBadgeRowContext: () => mockContext }));
jest.mock('~/hooks/MCP/useMCPRefresh', () => ({
  useMCPRefresh: (options: unknown) => mockRefresh(options),
}));
jest.mock('~/hooks/Input/useMentions', () => ({
  __esModule: true,
  default: () => ({ options: modelOptions, isLoading: false, assistantListMap: {} }),
}));
jest.mock('~/hooks/Input/useSelectMention', () => ({
  __esModule: true,
  default: () => ({ onSelectMention: mockSelectModel }),
}));

const popoverAtom = atom({ key: 'mcp-mention-test', default: true });
const renderPicker = (text = '@', enabled = true, caret = text.length) => {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setSelectionRange(caret, caret);
  document.body.appendChild(textarea);
  const textAreaRef = { current: textarea };
  const onSubmit = jest.fn((event: React.FormEvent) => event.preventDefault());
  const ui = () => (
    <RecoilRoot>
      <form onSubmit={onSubmit}>
        <Mention
          index={0}
          popoverAtom={popoverAtom}
          newConversation={jest.fn()}
          textAreaRef={textAreaRef}
          mcpMentionsEnabled={enabled}
        />
      </form>
    </RecoilRoot>
  );
  return { ...render(ui()), textarea, onSubmit, ui };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockContext = { mcpServerManager: makeManager() };
  Element.prototype.scrollIntoView = jest.fn();
});
afterEach(() => document.body.replaceChildren());

it('searches canonical server keys and preserves the inline draft and model', () => {
  const { textarea, onSubmit } = renderPicker('Find @git tomorrow', true, 9);
  expect(screen.queryByRole('option', { name: 'Example model' })).toBeNull();
  expect(screen.getAllByRole('option')).toHaveLength(2);
  expect(screen.getAllByRole('option')[0]).toHaveTextContent('github');
  expect(screen.getAllByRole('option')[0]).toHaveTextContent('com_ui_mcp_mention_selected');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gitlab' } });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(mockSelectServer).toHaveBeenCalledWith('gitlab');
  expect(mockSelectModel).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(textarea).toHaveValue('Find  tomorrow');
  expect(textarea.selectionStart).toBe(5);
  expect(textarea).toHaveFocus();
});

it('keeps model selection and MCP selection distinct at the beginning of the draft', () => {
  renderPicker();
  expect(screen.getAllByRole('option')).toHaveLength(3);
  fireEvent.click(screen.getByRole('option', { name: 'Example model' }));
  expect(mockSelectModel).toHaveBeenCalledWith(modelOptions[0]);
  expect(mockSelectServer).not.toHaveBeenCalled();
});

it('keeps legacy model-only results when the feature is disabled', () => {
  renderPicker('@', false);
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(mockRefresh).toHaveBeenLastCalledWith({ enabled: false });
});

it('shows servers when the catalog arrives after the picker is already open', () => {
  mockContext.mcpServerManager.selectableServers = [];
  const { rerender, ui } = renderPicker();
  expect(screen.getAllByRole('option')).toHaveLength(1);
  mockContext = { mcpServerManager: makeManager() };
  rerender(ui());
  expect(screen.getAllByRole('option')).toHaveLength(3);
});

it('offers a retry for catalog failure without sending a message', () => {
  mockContext.mcpServerManager.isCatalogError = true;
  const { onSubmit } = renderPicker();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(mockRefetch).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
});
