import { registerSessionCleanup, runSessionCleanups } from '../session';

test('runs every registered cleanup once per session end and stops after unregistering', () => {
  const first = jest.fn();
  const second = jest.fn();
  const forgetFirst = registerSessionCleanup(first);
  const forgetSecond = registerSessionCleanup(second);
  runSessionCleanups();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  forgetFirst();
  runSessionCleanups();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
  forgetSecond();
});

test('a failing cleanup does not prevent the others from running', () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const failing = registerSessionCleanup(() => {
    throw new Error('storage unavailable');
  });
  const survivor = jest.fn();
  const forget = registerSessionCleanup(survivor);
  expect(() => runSessionCleanups()).not.toThrow();
  expect(survivor).toHaveBeenCalledTimes(1);
  failing();
  forget();
  error.mockRestore();
});
