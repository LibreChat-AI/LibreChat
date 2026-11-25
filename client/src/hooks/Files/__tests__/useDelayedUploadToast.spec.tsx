import { Provider } from 'jotai';
import * as RadixToast from '@radix-ui/react-toast';
import { act, renderHook, screen } from '@testing-library/react';
import { Toast, ToastProvider, ToastViewport } from '@librechat/client';
import { useDelayedUploadToast } from '../useDelayedUploadToast';

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default:
    () =>
    (_key: string, { 0: fileName }: { 0: string }) =>
      `Still uploading ${fileName}`,
}));

function setup() {
  const { result } = renderHook(() => useDelayedUploadToast(), {
    wrapper: ({ children }) => (
      <Provider>
        <RadixToast.Provider>
          <ToastProvider>
            {children}
            <Toast />
            <ToastViewport />
          </ToastProvider>
        </RadixToast.Provider>
      </Provider>
    ),
  });
  return (fileName: string) => result.current(fileName, 1000);
}

const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms));
const warning = (fileName: string) => screen.queryByText(`Still uploading ${fileName}`);

describe('Slow upload warnings', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test.each([4000, 5050])('never appears if the upload settles at %i ms', (elapsed) => {
    const start = setup();
    const settle = start('report.pdf');
    advance(elapsed);

    act(settle);
    advance(200);
    expect(warning('report.pdf')).not.toBeInTheDocument();
    advance(6000);
    expect(warning('report.pdf')).not.toBeInTheDocument();
  });

  test('disappears immediately when the upload settles', () => {
    const start = setup();
    const settle = start('report.pdf');
    advance(5100);
    expect(warning('report.pdf')).toBeInTheDocument();

    act(settle);
    expect(warning('report.pdf')).not.toBeInTheDocument();
  });

  test('does not dismiss the warning for a different upload', () => {
    const start = setup();
    const settleFirst = start('first.pdf');
    advance(5100);
    expect(warning('first.pdf')).toBeInTheDocument();

    const settleSecond = start('second.pdf');
    advance(5100);
    expect(warning('second.pdf')).toBeInTheDocument();

    act(settleFirst);
    expect(warning('second.pdf')).toBeInTheDocument();
    act(settleSecond);
    expect(warning('second.pdf')).not.toBeInTheDocument();
  });
});
