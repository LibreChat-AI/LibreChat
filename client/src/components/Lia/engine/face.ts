import type { Ctx } from './pixels';
import { C, rect, sprite, dither } from './pixels';

/* The face is drawn in screen-local coordinates: the CRT screen is 32 x 21 pixels. */
export const SCREEN_W = 32;
export const SCREEN_H = 21;

export const FEATHER_ROWS = [
  '.....ooo',
  '...ooaao',
  '..oaabao',
  '.oaabao.',
  '.oabaoo.',
  'o.ooo...',
  'o.......',
];
export const FEATHER_PAL = { o: C.O, a: C.FEATHER, b: C.FEATHER_HI };

type Eye =
  | 'normal'
  | 'blink'
  | 'half'
  | 'tired'
  | 'closed'
  | 'happy'
  | 'sad'
  | 'big'
  | 'sparkle'
  | 'dot'
  | 'star'
  | 'heart'
  | 'question'
  | 'x'
  | 'spiral'
  | 'wide'
  | 'dash'
  | 'equals'
  | 'squeeze'
  | 'dollar'
  | 'angry'
  | 'side'
  | 'tear'
  | 'cry';
type Mouth =
  | 'smile'
  | 'grin'
  | 'beam'
  | 'laugh'
  | 'o'
  | 'gasp'
  | 'tiny'
  | 'sleep'
  | 'flat'
  | 'wavy'
  | 'frown'
  | 'pout'
  | 'smirk'
  | 'tongue'
  | 'cat'
  | 'teeth'
  | 'kiss'
  | 'whistle'
  | 'drool'
  | 'chew';
type Brow = 'worried' | 'angry' | 'raised' | 'skeptic' | 'focus';
type Extra =
  | 'blush'
  | 'sweat'
  | 'vein'
  | 'tears'
  | 'sparkles'
  | 'shades'
  | 'glasses'
  | 'monocle'
  | 'mustache'
  | 'sick'
  | 'bandage'
  | 'zzz'
  | 'think';

export interface FaceState {
  face: string;
  /** Milliseconds since this expression started; drives entrances like the sunglasses drop. */
  elapsed: number;
  dx: number;
  dy: number;
  feather: boolean;
  t: number;
  blink: boolean;
}

export interface Expression {
  key: string;
  /** Translation key for the feeling, like `com_ui_lia_feel_happy`. */
  label: `com_ui_lia_feel_${string}`;
  eyes: Eye | readonly [Eye, Eye];
  mouth: Mouth;
  brows?: Brow;
  extras: readonly Extra[];
  /** Arm pose, effect and body pose that suit the expression when Lia plays it as an emote. */
  arms?: string;
  pose?: string;
}

const BLINKABLE: ReadonlySet<Eye> = new Set([
  'normal',
  'big',
  'sparkle',
  'wide',
  'dot',
  'tear',
  'sad',
  'angry',
]);

export function blobDistance(x: number, y: number) {
  const dx = (x + 0.5 - 16.5) / 12.5;
  const dy = (y + 0.5 - 10.5) / 8.5;
  return dx * dx + dy * dy;
}

/** The glowing face blob, optionally dithered in at `level` (used by the boot sequence). */
export function drawBlob(c: Ctx, level: number) {
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const d = blobDistance(x, y);
      let color: string | null = null;
      if (d < 0.78) {
        color = C.BLOB;
      } else if (d < 1) {
        color = (x + y) & 1 ? C.BLOB : C.GLOW;
      } else if (d < 1.45) {
        color = dither(x, y, ((1.45 - d) / 0.45) * 0.7) ? C.GLOW : null;
      } else if (x === 0 || x === SCREEN_W - 1 || y === 0 || y === SCREEN_H - 1) {
        color = C.DEEP;
      }
      if (color && (level >= 1 || dither(x, y, level))) {
        rect(c, x, y, 1, 1, color);
      }
    }
  }
}

function drawEye(c: Ctx, kind: Eye, x: number, y: number, left: boolean, t: number) {
  const E = C.EYE;
  const round = (yy: number) => {
    rect(c, x, yy, 1, 1, C.BLOB);
    rect(c, x + 3, yy, 1, 1, C.BLOB);
  };
  switch (kind) {
    case 'blink':
      rect(c, x, y + 2, 4, 1, E);
      return;
    case 'half':
      rect(c, x, y + 2, 4, 2, E);
      round(y + 3);
      return;
    case 'tired':
      rect(c, x, y + 2, 4, 2, E);
      round(y + 3);
      rect(c, x, y + 5, 4, 1, C.GLOW);
      return;
    case 'closed':
      rect(c, x, y + 1, 1, 1, E);
      rect(c, x + 1, y + 2, 2, 1, E);
      rect(c, x + 3, y + 1, 1, 1, E);
      return;
    case 'happy':
      rect(c, x, y + 2, 1, 1, E);
      rect(c, x + 1, y + 1, 2, 1, E);
      rect(c, x + 3, y + 2, 1, 1, E);
      return;
    case 'sad':
    case 'angry': {
      /* Both are a normal eye with one top corner cut away; the side decides the mood. */
      const outer = kind === 'sad' ? left : !left;
      rect(c, x, y, 4, 4, E);
      round(y + 3);
      rect(c, outer ? x : x + 2, y, 2, 1, C.BLOB);
      rect(c, outer ? x : x + 3, y + 1, 1, 1, C.BLOB);
      rect(c, outer ? x + 2 : x + 1, y + 2, 1, 1, C.W);
      return;
    }
    case 'big':
      rect(c, x, y - 1, 4, 5, E);
      round(y - 1);
      round(y + 3);
      rect(c, x + 2, y, 1, 1, C.W);
      rect(c, x + 1, y + 2, 1, 1, C.W);
      return;
    case 'sparkle':
      rect(c, x - 1, y - 1, 6, 6, E);
      for (const [a, b] of [
        [x - 1, y - 1],
        [x + 4, y - 1],
        [x - 1, y + 4],
        [x + 4, y + 4],
      ]) {
        rect(c, a, b, 1, 1, C.BLOB);
      }
      rect(c, x + 2, y, 2, 2, C.W);
      rect(c, x, y + 3, 1, 1, C.W);
      return;
    case 'dot':
      rect(c, x + 1, y + 1, 2, 2, E);
      return;
    case 'star':
      rect(c, x + 1, y, 2, 4, C.STAR);
      rect(c, x, y + 1, 4, 2, C.STAR);
      rect(c, x + 1, y + 1, 1, 1, C.W);
      return;
    case 'heart':
      sprite(c, ['.#.#.', '#####', '.###.', '..#..'], x - (left ? 1 : 0), y, { '#': C.HEART });
      rect(c, x + (left ? 0 : 1), y + 1, 1, 1, C.HEART_HI);
      return;
    case 'question':
      sprite(c, ['.oo.', 'o..o', '..o.', '..o.', '....', '..o.'], x, y - 1, { o: E });
      return;
    case 'x':
      for (let i = 0; i < 4; i++) {
        rect(c, x + i, y + i, 1, 1, E);
        rect(c, x + 3 - i, y + i, 1, 1, E);
      }
      return;
    case 'spiral': {
      const ring = [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
        [3, 1],
        [3, 2],
        [3, 3],
        [2, 3],
        [1, 3],
        [0, 3],
        [0, 2],
        [0, 1],
      ];
      const k = Math.floor(t / 90) % 12;
      ring.forEach(([a, b], i) => {
        if ((i - k + 12) % 12 > 2) {
          rect(c, x + a, y + b, 1, 1, E);
        }
      });
      rect(c, x + 1, y + 1, 1, 1, E);
      return;
    }
    case 'wide':
      rect(c, x - 1, y - 1, 5, 5, E);
      rect(c, x, y, 3, 3, C.BLOB);
      rect(c, x + 1, y + 1, 1, 1, E);
      return;
    case 'dash':
      rect(c, x, y + 1, 4, 2, E);
      return;
    case 'equals':
      rect(c, x, y + 1, 4, 1, E);
      rect(c, x, y + 3, 4, 1, E);
      return;
    case 'squeeze':
      sprite(
        c,
        left ? ['#...', '.##.', '...#', '.##.', '#...'] : ['...#', '.##.', '#...', '.##.', '...#'],
        x,
        y - 1,
        { '#': E },
      );
      return;
    case 'dollar':
      sprite(c, ['.##.', '##..', '.##.', '..##', '.##.'], x, y - 1, { '#': C.MONEY });
      rect(c, x + 1, y - 2, 1, 1, C.MONEY);
      rect(c, x + 2, y + 4, 1, 1, C.MONEY);
      return;
    case 'side':
      rect(c, x, y + 1, 4, 3, E);
      rect(c, x, y + 2, 1, 1, C.W);
      return;
    case 'tear':
      rect(c, x, y, 4, 4, E);
      round(y);
      round(y + 3);
      rect(c, x + 2, y + 1, 1, 1, C.W);
      rect(c, x + 1, y + 4 + (Math.floor(t / 160) % 4), 1, 2, C.TEAR);
      return;
    case 'cry': {
      rect(c, x, y + 1, 4, 1, E);
      const k = Math.floor(t / 110) % 3;
      for (let i = 0; i < 4; i++) {
        if ((i + k) % 3) {
          rect(c, x, y + 2 + i, 1, 1, C.TEAR);
          rect(c, x + 3, y + 2 + i, 1, 1, C.TEAR);
        }
      }
      return;
    }
    default:
      rect(c, x, y, 4, 4, E);
      round(y);
      round(y + 3);
      rect(c, x + 2, y + 1, 1, 1, C.W);
  }
}

function drawMouth(c: Ctx, kind: Mouth, t: number) {
  const E = C.EYE;
  const dots = (pts: ReadonlyArray<readonly [number, number]>) =>
    pts.forEach(([x, y]) => rect(c, x, y, 1, 1, E));
  switch (kind) {
    case 'grin':
      rect(c, 13, 15, 7, 1, E);
      rect(c, 14, 16, 1, 1, E);
      rect(c, 15, 16, 3, 1, C.PINK);
      rect(c, 18, 16, 1, 1, E);
      rect(c, 15, 17, 3, 1, E);
      return;
    case 'beam':
      dots([
        [13, 14],
        [13, 15],
        [14, 16],
        [15, 17],
        [16, 17],
        [17, 17],
        [18, 16],
        [19, 15],
        [19, 14],
      ]);
      rect(c, 14, 14, 5, 2, E);
      rect(c, 15, 16, 3, 1, C.PINK);
      return;
    case 'laugh':
      sprite(c, ['#######', '#ppppp#', '.#ppp#.', '..###..'], 13, 14 + (Math.floor(t / 120) % 2), {
        '#': E,
        p: C.PINK,
      });
      return;
    case 'o':
      rect(c, 15, 15, 3, 3, E);
      rect(c, 16, 16, 1, 1, C.PINK);
      return;
    case 'gasp':
      rect(c, 14, 14, 5, 4, E);
      rect(c, 14, 14, 1, 1, C.BLOB);
      rect(c, 18, 14, 1, 1, C.BLOB);
      rect(c, 15, 15, 3, 2, C.PINK);
      return;
    case 'tiny':
      rect(c, 15, 16, 3, 1, E);
      return;
    case 'sleep':
      rect(c, 16, 16, 2, 1 + (Math.floor(t / 900) % 2), E);
      return;
    case 'flat':
      rect(c, 14, 16, 5, 1, E);
      return;
    case 'wavy':
      for (let i = 0; i < 7; i++) {
        rect(c, 13 + i, i % 2 ? 15 : 16, 1, 1, E);
      }
      return;
    case 'frown':
      rect(c, 13, 17, 1, 1, E);
      rect(c, 14, 16, 5, 1, E);
      rect(c, 19, 17, 1, 1, E);
      return;
    case 'pout':
      dots([
        [15, 17],
        [16, 16],
        [17, 17],
      ]);
      return;
    case 'smirk':
      rect(c, 14, 16, 4, 1, E);
      rect(c, 18, 15, 1, 1, E);
      return;
    case 'tongue':
      drawMouth(c, 'smile', t);
      rect(c, 16, 17, 2, 2, C.PINK);
      rect(c, 16, 18, 1, 1, C.HEART);
      return;
    case 'cat':
      dots([
        [13, 15],
        [14, 16],
        [15, 16],
        [16, 15],
        [17, 16],
        [18, 16],
        [19, 15],
      ]);
      return;
    case 'teeth':
      rect(c, 13, 15, 7, 3, E);
      rect(c, 14, 16, 5, 1, C.W);
      rect(c, 15, 16, 1, 1, E);
      rect(c, 17, 16, 1, 1, E);
      return;
    case 'kiss':
      rect(c, 16, 15, 2, 1, E);
      rect(c, 18, 16, 1, 1, E);
      rect(c, 16, 17, 2, 1, E);
      rect(c, 16, 16, 2, 1, C.HEART);
      return;
    case 'whistle':
      rect(c, 18, 15, 2, 2, E);
      rect(c, 18, 15, 1, 1, C.PINK);
      return;
    case 'drool':
      drawMouth(c, 'smile', t);
      rect(c, 18, 17, 1, 1 + (Math.floor(t / 250) % 3), C.GLOW);
      return;
    case 'chew':
      if (Math.floor(t / 160) % 2) {
        rect(c, 15, 15, 3, 2, E);
      } else {
        rect(c, 14, 16, 5, 1, E);
      }
      return;
    default:
      rect(c, 13, 15, 1, 1, E);
      rect(c, 14, 16, 5, 1, E);
      rect(c, 19, 15, 1, 1, E);
  }
}

const BROWS: Record<Brow, ReadonlyArray<readonly [number, number, number]>> = {
  worried: [
    [8, 6, 2],
    [10, 5, 2],
    [21, 5, 2],
    [23, 6, 2],
  ],
  angry: [
    [8, 5, 2],
    [10, 6, 2],
    [21, 6, 2],
    [23, 5, 2],
  ],
  raised: [
    [8, 5, 4],
    [21, 5, 4],
  ],
  skeptic: [
    [8, 6, 4],
    [21, 4, 4],
  ],
  focus: [
    [8, 6, 4],
    [21, 6, 4],
  ],
};

const EXTRAS: Record<Extra, (c: Ctx, fs: FaceState) => void> = {
  blush: (c) => {
    rect(c, 4, 13, 3, 1, C.PINK);
    rect(c, 25, 13, 3, 1, C.PINK);
    rect(c, 5, 14, 1, 1, C.PINK);
    rect(c, 26, 14, 1, 1, C.PINK);
  },
  sweat: (c, fs) => {
    const y = 2 + (Math.floor(fs.t / 220) % 4);
    rect(c, 28, y, 1, 1, C.TEAR);
    rect(c, 27, y + 1, 3, 2, C.TEAR);
    rect(c, 28, y + 1, 1, 1, C.W);
  },
  vein: (c) => sprite(c, ['.#.#.', '##.##', '.....', '##.##', '.#.#.'], 25, 1, { '#': C.VEIN }),
  tears: (c, fs) => {
    const k = Math.floor(fs.t / 120) % 4;
    for (let i = 0; i < 3; i++) {
      rect(c, 9, 12 + ((i * 2 + k) % 8), 1, 1, C.TEAR);
      rect(c, 22, 12 + ((i * 2 + k + 1) % 8), 1, 1, C.TEAR);
    }
  },
  sparkles: (c, fs) => {
    const k = Math.floor(fs.t / 200) % 3;
    const spots = [
      [3, 3],
      [28, 4],
      [4, 16],
      [27, 15],
    ];
    spots.forEach(([x, y], i) => {
      if ((i + k) % 3) {
        rect(c, x, y - 1, 1, 3, C.W);
        rect(c, x - 1, y, 3, 1, C.W);
      }
    });
  },
  shades: (c, fs) => {
    /* The glasses drop in from above when the expression starts. */
    const y = 8 + Math.min(0, -8 + Math.floor(fs.elapsed / 45));
    rect(c, 6, y, 8, 4, C.EYE);
    rect(c, 19, y, 8, 4, C.EYE);
    rect(c, 14, y + 1, 5, 1, C.EYE);
    rect(c, 7, y + 1, 2, 1, '#5d7f9e');
    rect(c, 20, y + 1, 2, 1, '#5d7f9e');
    for (const x of [6, 13, 19, 26]) {
      rect(c, x, y + 3, 1, 1, C.BLOB);
    }
  },
  glasses: (c) => {
    for (const x of [6, 19]) {
      rect(c, x, 6, 8, 1, C.EYE);
      rect(c, x, 12, 8, 1, C.EYE);
      rect(c, x, 6, 1, 7, C.EYE);
      rect(c, x + 7, 6, 1, 7, C.EYE);
    }
    rect(c, 14, 8, 5, 1, C.EYE);
  },
  monocle: (c) => {
    rect(c, 19, 6, 7, 1, C.STAR);
    rect(c, 19, 12, 7, 1, C.STAR);
    rect(c, 19, 6, 1, 7, C.STAR);
    rect(c, 25, 6, 1, 7, C.STAR);
    rect(c, 25, 13, 1, 6, C.STAR);
  },
  mustache: (c) => sprite(c, ['.##.##.', '###.###', '#.....#'], 13, 12, { '#': '#5a3a22' }),
  sick: (c) => {
    for (let y = 1; y < SCREEN_H - 1; y++) {
      for (let x = 2; x < SCREEN_W - 2; x++) {
        if (blobDistance(x, y) < 0.9 && dither(x, y, 0.3)) {
          rect(c, x, y, 1, 1, '#b5d99c');
        }
      }
    }
  },
  bandage: (c) => {
    rect(c, 24, 2, 6, 2, '#f1d3a8');
    rect(c, 26, 2, 1, 2, '#c9a77a');
    rect(c, 28, 2, 1, 2, '#c9a77a');
  },
  zzz: (c, fs) => {
    if (Math.floor(fs.t / 500) % 2) {
      sprite(c, ['###', '..#', '.#.', '#..', '###'], 26, 2, { '#': C.GLOW });
    }
  },
  think: (c, fs) => {
    const k = Math.floor(fs.t / 300) % 4;
    for (let i = 0; i < k; i++) {
      rect(c, 24 + i * 2, 3, 1, 1, C.EYE);
    }
  },
};

type Row = [
  key: string,
  label: `com_ui_lia_feel_${string}`,
  eyes: Eye | readonly [Eye, Eye],
  mouth: Mouth,
  brows?: Brow | null,
  extras?: readonly Extra[] | null,
  arms?: string | null,
  pose?: string | null,
];

const ROWS: Row[] = [
  ['neutral', 'com_ui_lia_feel_neutral', 'normal', 'smile'],
  ['happy', 'com_ui_lia_feel_happy', 'happy', 'grin'],
  ['joyful', 'com_ui_lia_feel_joyful', 'happy', 'beam', null, ['sparkles'], 'cheer', 'bounce'],
  ['laughing', 'com_ui_lia_feel_laughing', 'squeeze', 'laugh', null, null, null, 'shake'],
  ['giggle', 'com_ui_lia_feel_giggle', 'closed', 'cat', null, null, 'cover', 'wiggle'],
  ['content', 'com_ui_lia_feel_content', 'closed', 'smile'],
  ['smug', 'com_ui_lia_feel_smug', 'side', 'smirk', 'raised'],
  ['wink', 'com_ui_lia_feel_wink', ['normal', 'blink'], 'grin', null, null, 'thumbs'],
  ['cheeky', 'com_ui_lia_feel_cheeky', ['blink', 'normal'], 'tongue'],
  ['love', 'com_ui_lia_feel_love', 'heart', 'beam', null, ['blush'], 'hug', 'sway'],
  ['starstruck', 'com_ui_lia_feel_starstruck', 'star', 'gasp', null, ['sparkles'], 'jazz'],
  ['blushing', 'com_ui_lia_feel_blushing', 'closed', 'smile', null, ['blush']],
  ['shy', 'com_ui_lia_feel_shy', 'dot', 'tiny', null, ['blush'], 'hug', 'tilt'],
  ['curious', 'com_ui_lia_feel_curious', 'big', 'o', 'skeptic', null, null, 'tilt'],
  ['confused', 'com_ui_lia_feel_confused', 'question', 'wavy', 'skeptic', null, 'scratch', 'tiltR'],
  ['thinking', 'com_ui_lia_feel_thinking', 'side', 'flat', 'skeptic', ['think'], 'scratch'],
  ['skeptical', 'com_ui_lia_feel_skeptical', 'half', 'flat', 'skeptic'],
  ['surprised', 'com_ui_lia_feel_surprised', 'big', 'o', 'raised'],
  ['shocked', 'com_ui_lia_feel_shocked', 'wide', 'gasp', 'raised', null, 'shrug', 'jump'],
  ['scared', 'com_ui_lia_feel_scared', 'wide', 'wavy', 'worried', ['sweat'], 'shield', 'shiver'],
  ['nervous', 'com_ui_lia_feel_nervous', 'normal', 'wavy', 'worried', ['sweat']],
  ['sad', 'com_ui_lia_feel_sad', 'sad', 'frown', 'worried', null, null, 'slump'],
  ['crying', 'com_ui_lia_feel_crying', 'cry', 'frown', 'worried', null, 'rub'],
  ['sobbing', 'com_ui_lia_feel_sobbing', 'cry', 'gasp', 'worried', ['tears'], null, 'shake'],
  ['pouting', 'com_ui_lia_feel_pouting', 'dot', 'pout', 'angry', ['blush'], 'hips'],
  ['angry', 'com_ui_lia_feel_angry', 'angry', 'teeth', 'angry', ['vein'], 'box'],
  ['furious', 'com_ui_lia_feel_furious', 'angry', 'gasp', 'angry', ['vein'], 'shrug', 'stomp'],
  ['annoyed', 'com_ui_lia_feel_annoyed', 'equals', 'flat', null, null, 'hips'],
  ['bored', 'com_ui_lia_feel_bored', 'half', 'flat', null, null, null, 'slump'],
  ['sleepy', 'com_ui_lia_feel_sleepy', 'half', 'tiny', null, null, 'rub'],
  ['asleep', 'com_ui_lia_feel_asleep', 'closed', 'sleep', null, ['zzz'], null, 'sit'],
  ['dizzy', 'com_ui_lia_feel_dizzy', 'x', 'wavy', null, null, null, 'dizzy'],
  ['dazed', 'com_ui_lia_feel_dazed', 'spiral', 'wavy', null, null, null, 'dizzy'],
  ['sick', 'com_ui_lia_feel_sick', 'dash', 'wavy', 'worried', ['sick', 'sweat'], null, 'slump'],
  ['cool', 'com_ui_lia_feel_cool', 'normal', 'smirk', null, ['shades'], 'thumbs'],
  ['nerd', 'com_ui_lia_feel_nerd', 'normal', 'grin', null, ['glasses'], 'pointUp'],
  ['fancy', 'com_ui_lia_feel_fancy', 'closed', 'smile', null, ['monocle', 'mustache'], 'hips'],
  ['rich', 'com_ui_lia_feel_rich', 'dollar', 'grin', null, null, 'cheer'],
  ['hungry', 'com_ui_lia_feel_hungry', 'big', 'drool'],
  ['yummy', 'com_ui_lia_feel_yummy', 'happy', 'tongue', null, ['blush']],
  ['kissy', 'com_ui_lia_feel_kissy', 'closed', 'kiss', null, ['blush']],
  ['whistling', 'com_ui_lia_feel_whistling', 'half', 'whistle', null, null, null, 'sway'],
  ['determined', 'com_ui_lia_feel_determined', 'angry', 'flat', 'focus', null, 'flex'],
  ['proud', 'com_ui_lia_feel_proud', 'closed', 'beam', null, ['sparkles'], 'hips', 'tiptoe'],
  ['relieved', 'com_ui_lia_feel_relieved', 'closed', 'smile', null, ['sweat']],
  [
    'embarrassed',
    'com_ui_lia_feel_embarrassed',
    'dash',
    'wavy',
    null,
    ['blush', 'sweat'],
    'facepalm',
  ],
  ['mischievous', 'com_ui_lia_feel_mischievous', 'side', 'smirk', 'angry', null, 'rub'],
  ['sneezy', 'com_ui_lia_feel_sneezy', 'squeeze', 'gasp', 'raised'],
  ['focused', 'com_ui_lia_feel_focused', 'dash', 'flat', 'focus'],
  ['hopeful', 'com_ui_lia_feel_hopeful', 'sparkle', 'smile', 'worried'],
  ['grumpy', 'com_ui_lia_feel_grumpy', 'half', 'frown', 'angry'],
  ['catface', 'com_ui_lia_feel_catface', 'happy', 'cat'],
  ['deadpan', 'com_ui_lia_feel_deadpan', 'dot', 'flat'],
  ['zen', 'com_ui_lia_feel_zen', 'closed', 'smile', null, ['sparkles'], null, 'float'],
  ['excited', 'com_ui_lia_feel_excited', 'star', 'laugh', null, null, 'cheer', 'bounce'],
  ['tired', 'com_ui_lia_feel_tired', 'tired', 'tiny'],
  ['suspicious', 'com_ui_lia_feel_suspicious', 'side', 'pout', 'angry'],
  ['hurt', 'com_ui_lia_feel_hurt', 'squeeze', 'teeth', 'worried', ['bandage']],
  ['dreamy', 'com_ui_lia_feel_dreamy', 'half', 'smile', 'raised', ['sparkles'], null, 'sway'],
  ['startled', 'com_ui_lia_feel_startled', 'wide', 'o', 'raised', null, 'shield', 'jump'],
  ['chewing', 'com_ui_lia_feel_chewing', 'happy', 'chew'],
  ['amazed', 'com_ui_lia_feel_amazed', 'sparkle', 'gasp', 'raised', ['sparkles']],
];

export const EXPRESSIONS: readonly Expression[] = ROWS.map(
  ([key, label, eyes, mouth, brows, extras, arms, pose]) => ({
    key,
    label,
    eyes,
    mouth,
    brows: brows ?? undefined,
    extras: extras ?? [],
    arms: arms ?? undefined,
    pose: pose ?? undefined,
  }),
);
export const EXPRESSION_BY_KEY: ReadonlyMap<string, Expression> = new Map(
  EXPRESSIONS.map((e) => [e.key, e]),
);

let blobCache: HTMLCanvasElement | null = null;
function blobCanvas() {
  if (blobCache == null) {
    blobCache = document.createElement('canvas');
    blobCache.width = SCREEN_W;
    blobCache.height = SCREEN_H;
    const c = blobCache.getContext('2d');
    if (c) {
      drawBlob(c, 1);
    }
  }
  return blobCache;
}

export function drawFace(c: Ctx, fs: FaceState) {
  const ex = EXPRESSION_BY_KEY.get(fs.face) ?? EXPRESSIONS[0];
  rect(c, 0, 0, SCREEN_W, SCREEN_H, C.SCREEN);
  c.drawImage(blobCanvas(), 0, 0);
  if (ex.extras.includes('sick')) {
    EXTRAS.sick(c, fs);
  }
  if (fs.feather) {
    sprite(c, FEATHER_ROWS, 15, 0, FEATHER_PAL);
  }
  let [left, right] = typeof ex.eyes === 'string' ? [ex.eyes, ex.eyes] : ex.eyes;
  if (fs.blink) {
    left = BLINKABLE.has(left) ? 'blink' : left;
    right = BLINKABLE.has(right) ? 'blink' : right;
  }
  drawEye(c, left, 8 + fs.dx, 8 + fs.dy, true, fs.t);
  drawEye(c, right, 21 + fs.dx, 8 + fs.dy, false, fs.t);
  if (ex.brows) {
    for (const [x, y, w] of BROWS[ex.brows]) {
      rect(c, x + fs.dx, y + fs.dy, w, 1, C.EYE);
    }
  }
  drawMouth(c, ex.mouth, fs.t);
  for (const extra of ex.extras) {
    if (extra !== 'sick') {
      EXTRAS[extra](c, fs);
    }
  }
}
