import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider } from 'jotai';
import { Dialog } from '@radix-ui/react-dialog';
import DialogTemplate from './DialogTemplate';

describe('DialogTemplate', () => {
  let mockSelectHandler: jest.Mock;

  beforeEach(() => {
    mockSelectHandler = jest.fn();
  });

  it('renders correctly with all props', () => {
    const { getByText } = render(
      <Provider>
        <Dialog
          open
          data-testid="test-dialog"
          onOpenChange={() => {
            return;
          }}
        >
          <DialogTemplate
            title="Test Dialog"
            description="Test Description"
            main={<div>Main Content</div>}
            buttons={<button>Button</button>}
            leftButtons={<button>Left Button</button>}
            selection={{ selectHandler: mockSelectHandler, selectText: 'Select' }}
          />
        </Dialog>
      </Provider>,
    );

    expect(getByText('Test Dialog')).toBeInTheDocument();
    expect(getByText('Test Description')).toBeInTheDocument();
    expect(getByText('Main Content')).toBeInTheDocument();
    expect(getByText('Button')).toBeInTheDocument();
    expect(getByText('Left Button')).toBeInTheDocument();
    // Cancel text is hardcoded in DialogTemplate as 'cancel'
    expect(getByText('cancel')).toBeInTheDocument();
    expect(getByText('Select')).toBeInTheDocument();
  });

  it('renders correctly without optional props', () => {
    const { queryByText } = render(
      <Provider>
        <Dialog
          open
          onOpenChange={() => {
            return;
          }}
        ></Dialog>
      </Provider>,
    );

    expect(queryByText('Test Dialog')).toBeNull();
    expect(queryByText('Test Description')).not.toBeInTheDocument();
    expect(queryByText('Main Content')).not.toBeInTheDocument();
    expect(queryByText('Button')).not.toBeInTheDocument();
    expect(queryByText('Left Button')).not.toBeInTheDocument();
    expect(queryByText('cancel')).not.toBeInTheDocument();
    expect(queryByText('Select')).not.toBeInTheDocument();
  });

  it('calls selectHandler when the select button is clicked', () => {
    const { getByText } = render(
      <Provider>
        <Dialog
          open
          onOpenChange={() => {
            return;
          }}
        >
          <DialogTemplate
            title="Test Dialog"
            selection={{ selectHandler: mockSelectHandler, selectText: 'Select' }}
          />
        </Dialog>
      </Provider>,
    );

    fireEvent.click(getByText('Select'));

    expect(mockSelectHandler).toHaveBeenCalled();
  });
});
