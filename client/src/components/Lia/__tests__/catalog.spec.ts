import { EXPRESSIONS, EXPRESSION_BY_KEY } from '../engine/face';
import { ARMS, POSES, BUILTIN_SCREENS } from '../engine/body';
import { ACTIONS } from '../engine/catalog';

describe('Lia catalog', () => {
  it('has unique action ids', () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only references expressions, arms, poses and screens that exist', () => {
    for (const action of ACTIONS) {
      for (const [, spec] of action.steps) {
        if (spec.f != null) {
          expect({ id: action.id, f: EXPRESSION_BY_KEY.has(spec.f) }).toEqual({
            id: action.id,
            f: true,
          });
        }
        if (spec.a != null) {
          expect({ id: action.id, a: spec.a in ARMS }).toEqual({ id: action.id, a: true });
        }
        if (spec.o != null) {
          expect({ id: action.id, o: spec.o in POSES }).toEqual({ id: action.id, o: true });
        }
        if (spec.s != null && spec.s !== 'face') {
          expect({ id: action.id, s: BUILTIN_SCREENS.has(spec.s) }).toEqual({
            id: action.id,
            s: true,
          });
        }
      }
    }
  });

  it('gives every expression an emote whose arms and pose exist', () => {
    for (const ex of EXPRESSIONS) {
      expect(ACTIONS.some((a) => a.id === `feel-${ex.key}`)).toBe(true);
      if (ex.arms) {
        expect(ex.arms in ARMS).toBe(true);
      }
      if (ex.pose) {
        expect(ex.pose in POSES).toBe(true);
      }
    }
  });

  it('marks reactions as never chosen at random and flags actions that move', () => {
    for (const action of ACTIONS) {
      if (action.cat === 'react') {
        expect(action.noAuto).toBe(true);
      }
      expect(action.moves).toBe(action.steps.some(([, spec]) => spec.m != null));
    }
  });
});
