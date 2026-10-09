import { render, screen, waitFor } from '@testing-library/react';
import QueryDevtoolsGate, { shouldEnableQueryDevtools } from '../QueryDevtoolsGate';

jest.mock('@tanstack/react-query-devtools/production', () => ({
  ReactQueryDevtools: () => <div data-testid="query-devtools" />,
}));

describe('QueryDevtoolsGate', () => {
  it('keeps query devtools disabled in production by default', () => {
    expect(shouldEnableQueryDevtools({ isDevelopment: false, config: undefined })).toBe(false);

    const { container } = render(<QueryDevtoolsGate isDevelopment={false} config={undefined} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('query-devtools')).not.toBeInTheDocument();
  });

  it('enables query devtools in local development', async () => {
    render(<QueryDevtoolsGate isDevelopment={true} config={undefined} />);

    await waitFor(() => expect(screen.getByTestId('query-devtools')).toBeInTheDocument());
  });

  it('enables query devtools in production when the server-injected flag is true', async () => {
    render(<QueryDevtoolsGate isDevelopment={false} config={{ enableQueryDevtools: true }} />);

    await waitFor(() => expect(screen.getByTestId('query-devtools')).toBeInTheDocument());
  });
});
