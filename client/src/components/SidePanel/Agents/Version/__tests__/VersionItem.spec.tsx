import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import type { VersionRecord } from '../types';
import VersionItem from '../VersionItem';

jest.mock('~/hooks', () => ({
  useClockFormat: () => true,
  useLocalize: jest
    .fn()
    .mockImplementation(() => (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        com_ui_agent_version_title: params?.versionNumber
          ? `Version ${params.versionNumber}`
          : 'Version',
        com_ui_agent_version_current: 'Current',
        com_ui_agent_version_restore: 'Restore',
        com_ui_agent_version_restore_confirm: 'Are you sure you want to restore this version?',
        com_ui_agent_version_restore_description: 'This will replace your current configuration.',
        com_ui_agent_version_unknown_date: 'Unknown date',
        com_ui_agent_version_no_date: 'No date',
        com_ui_latest: 'Latest',
      };
      return translations[key] || key;
    }),
}));

jest.mock('@librechat/client', () => {
  const React = jest.requireActual('react');
  return {
    Label: ({ children, ...rest }: any) => React.createElement('label', rest, children),
    Button: ({ children, variant: _variant, size: _size, ...rest }: any) =>
      React.createElement('button', rest, children),
    TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
    OGDialog: ({ children }: any) => React.createElement(React.Fragment, null, children),
    OGDialogTrigger: ({ children }: any) => children,
    OGDialogTemplate: ({ selection }: any) =>
      React.createElement(
        'button',
        {
          'data-testid': 'restore-confirm-button',
          onClick: selection?.selectHandler,
        },
        selection?.selectText ?? 'Confirm',
      ),
  };
});

describe('VersionItem', () => {
  const mockVersion: VersionRecord = {
    name: 'Test Agent',
    description: 'Test Description',
    instructions: 'Test Instructions',
    updatedAt: '2023-01-01T00:00:00Z',
  };

  const defaultProps = {
    version: mockVersion,
    index: 1,
    isActive: false,
    versionsLength: 3,
    onRestore: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders version number', () => {
    render(<VersionItem {...defaultProps} />);
    expect(screen.getByText('Version 2')).toBeInTheDocument();
  });

  test('active version shows current badge and no restore action', () => {
    render(<VersionItem {...defaultProps} isActive={true} />);
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  test('inactive version renders restore trigger and no current badge', () => {
    render(<VersionItem {...defaultProps} isActive={false} />);
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Restore').length).toBeGreaterThan(0);
  });

  test('restoring through dialog confirmation invokes onRestore with index', () => {
    render(<VersionItem {...defaultProps} />);
    fireEvent.click(screen.getByTestId('restore-confirm-button'));
    expect(defaultProps.onRestore).toHaveBeenCalledWith(1);
  });

  test('handles invalid timestamp gracefully', () => {
    render(
      <VersionItem {...defaultProps} version={{ ...mockVersion, updatedAt: 'invalid-date' }} />,
    );
    expect(screen.getByText('Unknown date')).toBeInTheDocument();
  });

  test('handles missing timestamps with no-date fallback', () => {
    render(
      <VersionItem
        {...defaultProps}
        version={{ ...mockVersion, updatedAt: undefined, createdAt: undefined }}
      />,
    );
    expect(screen.getByText('No date')).toBeInTheDocument();
  });

  test('handles empty version object', () => {
    render(<VersionItem {...defaultProps} version={{}} />);
    expect(screen.getByText('No date')).toBeInTheDocument();
  });

  test('marks the most recent inactive version as latest', () => {
    render(<VersionItem {...defaultProps} index={0} isActive={false} />);
    expect(screen.getByText('Latest')).toBeInTheDocument();
  });
});
