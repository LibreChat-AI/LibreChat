import { StrictMode } from 'react';
import { RecoilRoot } from 'recoil';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { OpenIDSessionCheckResponse } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import OpenIDSessionGate from '../OpenIDSessionGate';

jest.mock('~/data-provider', () => ({ useGetStartupConfig: jest.fn() }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/hooks/AuthContext', () => ({ endSessionClientState: jest.fn() }));
jest.mock('~/utils', () => ({ persistRedirectToSession: jest.fn() }));
jest.mock('@librechat/client', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Spinner: () => <span>{'loading'}</span>,
}));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: { startOpenIDSessionCheck: jest.fn(), completeOpenIDSessionCheck: jest.fn() },
}));

const startup = useGetStartupConfig as jest.Mock;
const start = dataService.startOpenIDSessionCheck as jest.Mock;
function renderGate() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <StrictMode>
      <RecoilRoot>
        <QueryClientProvider client={queryClient}>
          <OpenIDSessionGate>
            <p>{'Private data'}</p>
          </OpenIDSessionGate>
        </QueryClientProvider>
      </RecoilRoot>
    </StrictMode>,
  );
}

it('leaves disabled deployments on the existing auth path', () => {
  startup.mockReturnValue({ data: { openidSessionCheckEnabled: false } });
  renderGate();
  expect(screen.getByText('Private data')).toBeVisible();
  expect(start).not.toHaveBeenCalled();
});

it('holds private content through failure, then permits it after an explicit successful retry', async () => {
  startup.mockReturnValue({
    data: { openidSessionCheckEnabled: true, serverDomain: 'http://localhost:3080' },
  });
  let resolve!: (value: OpenIDSessionCheckResponse) => void;
  start.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  renderGate();
  expect(screen.queryByText('Private data')).not.toBeInTheDocument();
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  resolve({ status: 'unavailable' });
  expect(await screen.findByRole('button', { name: 'com_ui_retry' })).toBeVisible();
  expect(screen.queryByText('Private data')).not.toBeInTheDocument();
  start.mockResolvedValueOnce({ status: 'verified' });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(await screen.findByText('Private data')).toBeVisible();
});
