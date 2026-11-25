import en from '~/locales/en/translation.json';
import { EXPRESSIONS } from '../engine/face';
import { ACTIONS } from '../engine/catalog';
import { SAY } from '../speech';

describe('Lia speech', () => {
  it('has an English label for everything Lia does and feels', () => {
    const labels = [
      ...ACTIONS.map((a) => a.label),
      ...EXPRESSIONS.map((e) => e.label),
      'com_ui_lia_doing',
      'com_ui_lia_act_idle',
    ];
    for (const label of labels) {
      expect({ label, present: label in en }).toEqual({ label, present: true });
    }
  });

  it('has an English line for every word Lia says', () => {
    for (const action of ACTIONS) {
      for (const [, spec] of action.steps) {
        if (spec.b && 'say' in spec.b) {
          const key = SAY[spec.b.say];
          expect({ say: spec.b.say, present: key in en }).toEqual({
            say: spec.b.say,
            present: true,
          });
        }
      }
    }
  });
});
