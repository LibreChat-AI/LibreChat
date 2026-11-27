import request from '../src/request';
import { getSubagentThreadMessages, SUBAGENT_THREAD_MESSAGES_PAGE } from '../src/data-service';

jest.mock('../src/request', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

const get = request.get as jest.Mock;
const row = { messageId: 'task-1:user', conversationId: 'thread-1', text: 'Go' };

describe('getSubagentThreadMessages', () => {
  beforeEach(() => get.mockReset());

  it('asks for one page, and hands back the page with the cursor before it', async () => {
    get.mockResolvedValue({ messages: [row], earlier: 'cursor-1' });

    const page = await getSubagentThreadMessages('parent-1', 'thread-1', { toolPreviews: true });

    expect(page).toEqual({ messages: [row], earlier: 'cursor-1' });
    const url = new URL(get.mock.calls[0][0], 'http://localhost');
    expect(url.pathname).toBe('/api/convos/parent-1/subagents/thread-1/messages');
    expect(url.searchParams.get('limit')).toBe(String(SUBAGENT_THREAD_MESSAGES_PAGE));
    expect(url.searchParams.has('cursor')).toBe(false);
    /** Tool previews ride along, as on a conversation load. */
    expect([...url.searchParams.keys()]).toHaveLength(2);
  });

  it('asks for the page before a cursor', async () => {
    get.mockResolvedValue({ messages: [row], earlier: null });

    await getSubagentThreadMessages('parent-1', 'thread-1', { cursor: 'cursor-1' });

    const url = new URL(get.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('cursor')).toBe('cursor-1');
  });

  it('takes a bare list from a server that predates paging as the whole thread', async () => {
    get.mockResolvedValue([row]);

    await expect(getSubagentThreadMessages('parent-1', 'thread-1')).resolves.toEqual({
      messages: [row],
      earlier: null,
    });
  });
});
