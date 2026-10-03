import { setActionClient, trackAction } from './actions';

describe('rum actions', () => {
  const addAction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    setActionClient(undefined);
  });

  it('does nothing until a client is set', () => {
    expect(() => trackAction('message.send', { model: 'model-a' })).not.toThrow();
    expect(addAction).not.toHaveBeenCalled();
  });

  it('forwards the action name and drops empty attributes', () => {
    setActionClient({ addAction });

    trackAction('message.send', {
      conversationId: 'convo-1',
      endpoint: 'bedrock',
      model: '',
      agentId: undefined,
      spec: null,
      count: 0,
      temporary: false,
    });

    expect(addAction).toHaveBeenCalledTimes(1);
    expect(addAction).toHaveBeenCalledWith('message.send', {
      conversationId: 'convo-1',
      endpoint: 'bedrock',
      count: 0,
      temporary: false,
    });
  });

  it('forwards an action without attributes', () => {
    setActionClient({ addAction });

    trackAction('conversation.new');

    expect(addAction).toHaveBeenCalledWith('conversation.new', undefined);
  });

  it('stops forwarding once the client is cleared', () => {
    setActionClient({ addAction });
    setActionClient(undefined);

    trackAction('message.copy');

    expect(addAction).not.toHaveBeenCalled();
  });

  it('swallows client failures', () => {
    setActionClient({
      addAction: () => {
        throw new Error('exporter unavailable');
      },
    });

    expect(() => trackAction('message.stop')).not.toThrow();
  });
});
