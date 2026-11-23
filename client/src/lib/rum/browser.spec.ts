import browser from './browser';

let mockRecording = false;
const mockRecorderInit = jest.fn<void, unknown[]>(() => {
  mockRecording = true;
});
const mockRecorderDeinit = jest.fn(() => {
  mockRecording = false;
});
const mockRumInit = jest.fn();
jest.mock('@hyperdx/otel-web', () => ({
  __esModule: true,
  default: { _internalInit: (...args: unknown[]) => mockRumInit(...args) },
}));
jest.mock('@hyperdx/otel-web-session-recorder', () => ({
  __esModule: true,
  default: {
    get inited() {
      return mockRecording;
    },
    init: (...args: unknown[]) => mockRecorderInit(...args),
    deinit: () => mockRecorderDeinit(),
  },
}));

const config = {
  apiKey: 'test-key',
  service: 'browser-test',
  url: '/api/rum',
  disableReplay: false,
  advancedNetworkCapture: false,
  consoleCapture: false,
  maskAllInputs: true,
  maskAllText: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRecording = false;
  document.querySelector('base')?.remove();
  history.replaceState({}, '', '/c/new');
});

it('installs URL-safe exporters and a pre-queue replay privacy plugin', () => {
  browser.init(config);
  expect(mockRumInit).toHaveBeenCalledWith(
    expect.objectContaining({ exporter: { factory: expect.any(Function) } }),
  );
  expect(mockRecorderInit).toHaveBeenCalledWith(
    expect.objectContaining({
      maskAllInputs: true,
      maskTextSelector: '*',
      recordCanvas: false,
      plugins: [expect.objectContaining({ eventProcessor: expect.any(Function) })],
    }),
  );
});

it('ends recording observers and restarts with a fresh snapshot rather than retaining auth-page mutations', () => {
  browser.init(config);
  browser.stopSessionRecorder();
  expect(mockRecorderDeinit).toHaveBeenCalledTimes(1);
  browser.resumeSessionRecorder();
  expect(mockRecorderInit).toHaveBeenCalledTimes(2);
  browser.resumeSessionRecorder();
  expect(mockRecorderInit).toHaveBeenCalledTimes(2);
});

it('never starts or resumes a recorder on an authentication screen', () => {
  browser.init(config);
  browser.stopSessionRecorder();
  history.replaceState({}, '', '/login/2fa?tempToken=fake-token');
  browser.resumeSessionRecorder();
  expect(mockRecorderInit).toHaveBeenCalledTimes(1);
  browser.init(config);
  expect(mockRecorderInit).toHaveBeenCalledTimes(1);
});

it.each(['/librechat/', '/librechat'])('recognizes the root login screen at %s', (pathname) => {
  const base = document.createElement('base');
  base.href = '/librechat/';
  document.head.append(base);
  history.replaceState({}, '', `${pathname}?tempToken=fake-token`);
  browser.init(config);
  expect(mockRecorderInit).not.toHaveBeenCalled();
});
