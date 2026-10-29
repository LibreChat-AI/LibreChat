import { writeGuarded, sendEvent, handleError } from './events';

type FakeRes = {
  write: jest.Mock;
  end: jest.Mock;
  writableEnded?: boolean;
  destroyed?: boolean;
};

const makeRes = (overrides: Partial<FakeRes> = {}): FakeRes => ({
  write: jest.fn(),
  end: jest.fn(),
  ...overrides,
});

describe('writeGuarded', () => {
  it('writes to a live response', () => {
    const res = makeRes();
    expect(writeGuarded(res, 'x')).toBe(true);
    expect(res.write).toHaveBeenCalledWith('x');
  });

  it('skips an ended response', () => {
    const res = makeRes({ writableEnded: true });
    expect(writeGuarded(res, 'x')).toBe(false);
    expect(res.write).not.toHaveBeenCalled();
  });

  it('skips a destroyed response', () => {
    const res = makeRes({ destroyed: true });
    expect(writeGuarded(res, 'x')).toBe(false);
    expect(res.write).not.toHaveBeenCalled();
  });
});

describe('sendEvent and handleError', () => {
  it('does not write after the response ended', () => {
    const res = makeRes({ writableEnded: true });
    sendEvent(res as never, { event: 'x' } as never);
    handleError(res as never, 'boom');
    expect(res.write).not.toHaveBeenCalled();
  });
});
