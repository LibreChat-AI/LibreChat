import * as endpoints from './api-endpoints';
import { getMessagesByConvoId } from './data-service';
import request from './request';

jest.mock('./request', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
  },
}));

const requestGet = request.get as jest.Mock;

describe('getMessagesByConvoId', () => {
  it('forwards the abort signal to the HTTP request', async () => {
    const controller = new AbortController();
    requestGet.mockResolvedValue([]);

    await getMessagesByConvoId('conversation-id', controller.signal);

    expect(requestGet).toHaveBeenCalledWith(
      endpoints.messages({ conversationId: 'conversation-id' }),
      {
        signal: controller.signal,
      },
    );
  });
});
