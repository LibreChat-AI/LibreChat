import { getMessageRowWidthClass } from '../width';

it('uses the standard reading column by default', () => {
  expect(getMessageRowWidthClass()).toBe('w-full sm:px-2 md:max-w-3xl xl:max-w-4xl');
});

it('widens parallel content', () => {
  expect(getMessageRowWidthClass({ hasParallelContent: true })).toBe(
    'w-full sm:px-2 md:max-w-[58rem] xl:max-w-[70rem]',
  );
});

it.each([false, true])('prioritizes full width over parallel content: %s', (hasParallelContent) => {
  expect(getMessageRowWidthClass({ fullWidth: true, hasParallelContent })).toBe(
    'w-full max-w-full sm:px-2',
  );
});
