import { ChannelExecutionError as CompatibilityError } from './execution';
import { ChannelExecutionError } from './errors';

it.each([
  'execution_not_prepared',
  'execution_identity_changed',
  'dispatch_outcome_unknown',
  'generation_missing',
  'generation_replaced',
  'stop_unconfirmed',
] as const)('preserves error identity and diagnostics for %s', (code) => {
  expect(CompatibilityError).toBe(ChannelExecutionError);
  const error = new ChannelExecutionError(code);
  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(CompatibilityError);
  expect(error.name).toBe('ChannelExecutionError');
  expect(error.message).toBe(code);
  expect(error.code).toBe(code);
});
