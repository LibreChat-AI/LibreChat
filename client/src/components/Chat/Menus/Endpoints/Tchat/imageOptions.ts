import { sanitizeImageChoice } from 'librechat-data-provider';
import type { TEphemeralAgent, TImageChoice, TImageSpec } from 'librechat-data-provider';
import { createStorageAtom } from '~/store/jotai-utils';

/** localStorage key holding the user's pinned image parameters, per `imageList` entry name. */
export const IMAGE_CHOICES_KEY = 'tchatImageChoices';

/**
 * App-wide, like the Image Gen model selection on mobile: a person who wants
 * 16:9 wants it in the next chat too, and keying by entry name keeps one
 * model's sizes from leaking onto another that does not offer them.
 */
export const imageChoicesAtom = createStorageAtom<Record<string, TImageChoice>>(
  IMAGE_CHOICES_KEY,
  {},
);

/** The entry Image Gen resolves to, mirroring the server's `resolveImageSpec`. */
export function activeImageSpec(
  selection: boolean | string | undefined,
  imageList: TImageSpec[] | undefined,
): TImageSpec | undefined {
  if (!selection || !imageList?.length) {
    return undefined;
  }
  const named =
    typeof selection === 'string' ? imageList.find((spec) => spec.name === selection) : undefined;
  return named ?? imageList.find((spec) => spec.default === true) ?? imageList[0];
}

function readChoices(): Record<string, TImageChoice> {
  try {
    const raw = localStorage.getItem(IMAGE_CHOICES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed != null && typeof parsed === 'object'
      ? (parsed as Record<string, TImageChoice>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The ephemeral agent a send carries, with the pinned parameters of whichever
 * image model it equips. Read at send time rather than kept on the agent, so
 * a model switch can never ship the previous model's choice.
 */
export function withImageChoice<T extends TEphemeralAgent | null | undefined>(
  ephemeralAgent: T,
  imageList: TImageSpec[] | undefined,
): T {
  const spec = activeImageSpec(ephemeralAgent?.image_gen, imageList);
  const choice = spec ? sanitizeImageChoice(spec.options, readChoices()[spec.name]) : undefined;
  if (ephemeralAgent == null || (choice == null && ephemeralAgent.image_options == null)) {
    return ephemeralAgent;
  }
  const { image_options: _stale, ...rest } = ephemeralAgent;
  return (choice ? { ...rest, image_options: choice } : rest) as T;
}

/** `1536x1024` → `3:2 · 1536×1024`, so a size reads as the shape it makes. */
export function sizeLabel(size: string): string {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    return size;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor} · ${width}×${height}`;
}
