import { frameLevel } from '../useAudioLevels';

/** A time-domain frame of a sine at the given peak amplitude (0-1). */
const sine = (amplitude: number, length = 1024) =>
  Uint8Array.from({ length }, (_, i) =>
    Math.round(128 + 127 * amplitude * Math.sin((2 * Math.PI * i) / 64)),
  );

describe('frameLevel', () => {
  it('reads silence as an empty bar', () => {
    expect(frameLevel(new Uint8Array(1024).fill(128))).toBe(0);
    expect(frameLevel(new Uint8Array(0))).toBe(0);
  });

  it('draws ordinary speech mid-range rather than as a dot', () => {
    /* Conversational speech peaks around 3-10% of full scale. */
    const quiet = frameLevel(sine(0.03));
    const normal = frameLevel(sine(0.1));
    expect(quiet).toBeGreaterThan(0.3);
    expect(normal).toBeGreaterThan(quiet);
    expect(normal).toBeLessThan(1);
  });

  it('saturates at full scale without exceeding it', () => {
    expect(frameLevel(sine(1))).toBe(1);
  });
});
