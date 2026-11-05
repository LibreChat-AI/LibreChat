import { render, screen } from '@testing-library/react';
import type { TModelsConfig, TStartupConfig } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import ModelSelector from '../ModelSelector';

let mockFetched = false;
let mockModels: TModelsConfig = { gateway: [] };
const mockSetSelected = jest.fn();
const mockContext = {
  agentsMap: {},
  modelSpecs: [],
  mappedEndpoints: [],
  endpointsConfig: { gateway: {} },
  searchValue: '',
  searchResults: null,
  selectedValues: { endpoint: 'gateway', model: 'saved-model', modelSpec: '' },
  setSearchValue: jest.fn(),
  setSelectedValues: mockSetSelected,
  keyDialogOpen: false,
  onOpenChange: jest.fn(),
  keyDialogEndpoint: '',
};
jest.mock('~/hooks/Endpoint/useModelCatalog', () => () => ({
  data: mockFetched ? mockModels : undefined,
}));
jest.mock('@librechat/client', () => ({
  TooltipAnchor: ({ render }: { render: ReactNode }) => render,
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}: ${values[0]}` : key,
}));
jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  useShortcutHint: () => '',
  useShortcutAriaKey: () => '',
}));
jest.mock('../ModelSelectorContext', () => ({
  ModelSelectorProvider: ({ children }: { children: ReactNode }) => children,
  useModelSelectorContext: () => mockContext,
}));
jest.mock('../ModelSelectorChatContext', () => ({
  ModelSelectorChatProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('../CustomMenu', () => ({
  CustomMenu: ({ trigger, children }: { trigger: ReactNode; children: ReactNode }) => (
    <div>
      {trigger}
      {children}
    </div>
  ),
}));
jest.mock('../components', () => ({
  renderModelSpecs: () => null,
  renderEndpoints: () => null,
  renderSearchResults: () => null,
  renderCustomGroups: () => null,
}));
jest.mock('../DialogManager', () => ({ __esModule: true, default: () => null }));
jest.mock('../utils', () => ({
  getSelectedIcon: () => null,
  getDisplayValue: () => 'saved-model',
}));

it('waits for discovery and shows an empty state with the saved unavailable choice', () => {
  const startupConfig = { interface: { modelSelect: true } } as TStartupConfig;
  const { rerender } = render(<ModelSelector startupConfig={startupConfig} />);
  expect(screen.queryByRole('status')).toBeNull();
  mockFetched = true;
  rerender(<ModelSelector startupConfig={startupConfig} />);
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_no_models_available');
  expect(screen.getByTestId('model-selector-button')).toHaveTextContent(
    'com_ui_model_unavailable: saved-model',
  );
  expect(mockSetSelected).not.toHaveBeenCalled();
  mockModels = { gateway: ['saved-model'] };
  rerender(<ModelSelector startupConfig={startupConfig} />);
  expect(screen.getByTestId('model-selector-button')).toHaveTextContent('saved-model');
  expect(screen.getByTestId('model-selector-button')).not.toHaveTextContent(
    'com_ui_model_unavailable',
  );
});
