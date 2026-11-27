import { createStore } from 'jotai';
import { duringRunActionAtom, migrateDuringRunAction } from './duringRun';

describe('during-run preference', () => {
  it.each([
    ['steer', false, 'steer'],
    ['steer', true, 'interrupt'],
    ['queue', false, 'queue'],
    ['queue', true, 'queue'],
    ['interrupt', false, 'interrupt'],
    ['invalid', true, 'steer'],
  ])('migrates %s / %s to %s', (legacy, interrupts, expected) => {
    expect(migrateDuringRunAction(legacy, interrupts)).toBe(expected);
  });

  it('persists each mode without overwriting legacy keys', () => {
    localStorage.setItem('duringRunDefaultAction', JSON.stringify('queue'));
    localStorage.setItem('steerInterruptsByDefault', JSON.stringify(true));
    const store = createStore();
    for (const mode of ['steer', 'interrupt', 'queue'] as const) {
      store.set(duringRunActionAtom, mode);
      expect(JSON.parse(localStorage.getItem('duringRunAction') ?? 'null')).toBe(mode);
    }
    expect(JSON.parse(localStorage.getItem('duringRunDefaultAction') ?? 'null')).toBe('queue');
    expect(JSON.parse(localStorage.getItem('steerInterruptsByDefault') ?? 'null')).toBe(true);
    localStorage.clear();
  });
});
