import '@testing-library/jest-dom/extend-expect';
import { render, fireEvent } from '@testing-library/react';
import type { VersionContext } from '../types';
import VersionContent from '../VersionContent';

const mockRestore = 'Restore';

jest.mock('../VersionItem', () => ({
  __esModule: true,
  default: jest.fn(({ version, isActive, onRestore, index }) => (
    <div data-testid="version-item">
      <div>{version.name}</div>
      {!isActive && (
        <button data-testid={`restore-button-${index}`} onClick={() => onRestore(index)}>
          {mockRestore}
        </button>
      )}
    </div>
  )),
}));

jest.mock('~/hooks', () => ({
  useLocalize: jest.fn().mockImplementation(() => (key) => {
    const translations = {
      com_ui_agent_version_no_agent: 'No agent selected',
      com_ui_agent_version_error: 'Error loading versions',
      com_ui_agent_version_empty: 'No versions available',
      com_ui_agent_version_restore_confirm: 'Are you sure you want to restore this version?',
      com_ui_agent_version_restore: 'Restore',
    };
    return translations[key] || key;
  }),
}));

jest.mock('@librechat/client', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

const mockVersionItem = jest.requireMock('../VersionItem').default;

describe('VersionContent', () => {
  const mockVersionIds = [
    { id: 0, version: { name: 'First' }, isActive: true, originalIndex: 2 },
    { id: 1, version: { name: 'Second' }, isActive: false, originalIndex: 1 },
    { id: 2, version: { name: 'Third' }, isActive: false, originalIndex: 0 },
  ];

  const mockContext: VersionContext = {
    versions: [{ name: 'First' }, { name: 'Second' }, { name: 'Third' }],
    versionIds: mockVersionIds,
    currentAgent: { name: 'Test Agent', description: null, instructions: null },
    selectedAgentId: 'agent-123',
    activeVersion: { name: 'First' },
  };

  const defaultProps = {
    selectedAgentId: 'agent-123',
    isLoading: false,
    error: null,
    versionContext: mockContext,
    onRestore: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    window.confirm = jest.fn(() => true);
  });

  test('renders different UI states correctly', () => {
    const renderTest = (props) => {
      const result = render(<VersionContent {...defaultProps} {...props} />);
      return result;
    };

    const { getByTestId, unmount: unmount1 } = renderTest({ isLoading: true });
    expect(getByTestId('spinner')).toBeInTheDocument();
    unmount1();

    const { getByText: getText1, unmount: unmount2 } = renderTest({
      error: new Error('Test error'),
    });
    expect(getText1('Error loading versions')).toBeInTheDocument();
    unmount2();

    const { getByText: getText2, unmount: unmount3 } = renderTest({ selectedAgentId: '' });
    expect(getText2('No agent selected')).toBeInTheDocument();
    unmount3();

    const emptyContext = { ...mockContext, versions: [], versionIds: [] };
    const { getByText: getText3, unmount: unmount4 } = renderTest({ versionContext: emptyContext });
    expect(getText3('No versions available')).toBeInTheDocument();
    unmount4();

    mockVersionItem.mockClear();

    const { getAllByTestId } = renderTest({});
    expect(getAllByTestId('version-item')).toHaveLength(3);
    expect(mockVersionItem).toHaveBeenCalledTimes(3);
  });

  test('restore functionality works correctly', () => {
    const onRestoreMock = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <VersionContent {...defaultProps} onRestore={onRestoreMock} />,
    );

    fireEvent.click(getByTestId('restore-button-1'));
    expect(onRestoreMock).toHaveBeenCalledWith(1);

    expect(queryByTestId('restore-button-0')).not.toBeInTheDocument();
    expect(queryByTestId('restore-button-1')).toBeInTheDocument();
    expect(queryByTestId('restore-button-2')).toBeInTheDocument();
  });

  test('handles edge cases in data', () => {
    const { getAllByTestId, getByText, queryByTestId, queryByText, rerender } = render(
      <VersionContent {...defaultProps} versionContext={{ ...mockContext, versions: [] }} />,
    );
    expect(getAllByTestId('version-item')).toHaveLength(mockVersionIds.length);

    rerender(
      <VersionContent {...defaultProps} versionContext={{ ...mockContext, versionIds: [] }} />,
    );
    expect(getByText('No versions available')).toBeInTheDocument();

    rerender(
      <VersionContent
        {...defaultProps}
        selectedAgentId=""
        isLoading={true}
        error={new Error('Test')}
      />,
    );
    expect(getByText('No agent selected')).toBeInTheDocument();
    expect(queryByTestId('spinner')).not.toBeInTheDocument();
    expect(queryByText('Error loading versions')).not.toBeInTheDocument();

    rerender(<VersionContent {...defaultProps} isLoading={true} error={new Error('Test')} />);
    expect(queryByTestId('spinner')).toBeInTheDocument();
    expect(queryByText('Error loading versions')).not.toBeInTheDocument();
  });
});
