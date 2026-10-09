import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Endpoint, SelectedValues } from '~/common';
import { EndpointItem } from '../EndpointItem';

const mockHandleSelectEndpoint = jest.fn();
const mockHandleOpenKeyDialog = jest.fn();
const mockSetEndpointSearchValue = jest.fn();

let mockSelectedValues: SelectedValues = { endpoint: '', model: '', modelSpec: '' };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Chat/Menus/Endpoints/ModelSelectorContext', () => ({
  useModelSelectorContext: () => ({
    agentsMap: undefined,
    assistantsMap: undefined,
    modelSpecs: [],
    selectedValues: mockSelectedValues,
    endpointSearchValues: {},
    handleOpenKeyDialog: mockHandleOpenKeyDialog,
    handleSelectEndpoint: mockHandleSelectEndpoint,
    setEndpointSearchValue: mockSetEndpointSearchValue,
    endpointRequiresUserKey: () => false,
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => {
  const React = jest.requireActual<typeof import('react')>('react');

  return {
    CustomMenu: ({ children, label }: { children?: React.ReactNode; label?: React.ReactNode }) =>
      React.createElement('div', null, label, children),
    CustomMenuItem: React.forwardRef(function MockMenuItem(
      { children, ...rest }: { children?: React.ReactNode },
      ref: React.Ref<HTMLButtonElement>,
    ) {
      return React.createElement('button', { ref, type: 'button', ...rest }, children);
    }),
    CustomMenuSeparator: () => React.createElement('hr'),
  };
});

const disabledAgentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: false,
  icon: null,
};

const customEndpoint: Endpoint = {
  value: 'custom',
  label: 'Custom',
  hasModels: false,
  icon: null,
};

describe('EndpointItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
  });

  it('does not render agents as a leaf endpoint when no selectable rows exist', () => {
    render(<EndpointItem endpoint={disabledAgentsEndpoint} endpointIndex={0} />);

    expect(screen.queryByText('My Agents')).not.toBeInTheDocument();
    expect(mockHandleSelectEndpoint).not.toHaveBeenCalled();
  });

  it('keeps non-agent endpoints without models selectable', () => {
    render(<EndpointItem endpoint={customEndpoint} endpointIndex={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    expect(mockHandleSelectEndpoint).toHaveBeenCalledWith(customEndpoint);
  });
});
