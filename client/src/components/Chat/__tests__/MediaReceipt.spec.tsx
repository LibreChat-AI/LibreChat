import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import MediaToolReceipt from '../Media/Receipt';

let mockStudio = true;
let mockShareId: string | undefined;
jest.mock('~/hooks/Media/useMediaAccess', () => ({
  useMediaAccess: () => ({ studio: mockStudio }),
}));
jest.mock('~/Providers', () => ({ useShareContext: () => ({ shareId: mockShareId }) }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const receipt = {
  jobId: 'job',
  threadId: 'thread/id',
  operation: 'video.generate',
  phase: 'queued',
};
const renderReceipt = (output: string) =>
  render(
    <MemoryRouter>
      <MediaToolReceipt output={output} />
    </MemoryRouter>,
  );

beforeEach(() => {
  mockStudio = true;
  mockShareId = undefined;
});

test('renders a durable creation link and labels status as a snapshot', () => {
  renderReceipt(JSON.stringify({ media: receipt }));
  expect(screen.getByRole('link', { name: 'com_media_open_thread' })).toHaveAttribute(
    'href',
    '/studio/threads/thread%2Fid',
  );
  expect(screen.getByText('com_media_tool_reported_status')).toBeVisible();
});

test.each(['disabled', 'shared'])(
  'keeps the receipt usable without exposing a Studio link when %s',
  (mode) => {
    mockStudio = mode !== 'disabled';
    mockShareId = mode === 'shared' ? 'share' : undefined;
    renderReceipt(JSON.stringify({ media: receipt }));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('com_media_tool_status_hint')).toBeVisible();
  },
);

test.each(['partial JSON', '{}', JSON.stringify({ media: { ...receipt, phase: 'invented' } })])(
  'ignores malformed or unrelated tool output %s',
  (output) => {
    const view = renderReceipt(output);
    expect(view.container).toBeEmptyDOMElement();
  },
);
