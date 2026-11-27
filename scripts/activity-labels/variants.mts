/**
 * Instruction variants under test. Each is a SINGLE-factor change against the
 * production instruction so a result implicates one hypothesis:
 *
 * - baseline    — ACTIVITY_INSTRUCTION exactly as the branch ships it
 * - verbs       — H: the Good-example verb distribution seeds register
 *                 collapse (6/9 production labels opened "Confirmed")
 * - ordered     — H: the 4–9 word cap gets crowded out mid-paragraph; moving
 *                 format constraints last improves adherence
 * - continuity  — H: showing the run's previous headers kills cross-batch
 *                 redundancy (production pairs 2/3 and 7/8)
 *
 * The baseline is required from packages/api/dist so drift against the branch
 * is impossible; the sentence table below is asserted against it so composed
 * variants can never silently diverge from what production actually sends.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import type { Variant } from './types.mts';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The shipped instruction, read from the BUILT package so a variant can never
 * be graded against a stale copy of it. Tries the workspace resolution first
 * (an installed checkout), then the dist path directly, so the harness works
 * whether or not `node_modules` is populated. `LABEL_EVAL_DIST` points it at
 * another checkout's build — useful for grading one branch's instruction from
 * a worktree that has not been built.
 */
interface ActivityInstructionModule {
  ACTIVITY_INSTRUCTION?: string;
}

function loadShippedInstruction(): string {
  const candidates = [
    process.env.LABEL_EVAL_DIST,
    '@librechat/api',
    join(ROOT, 'packages/api/dist/index.cjs'),
  ].filter((candidate): candidate is string => candidate != null);
  for (const candidate of candidates) {
    try {
      const { ACTIVITY_INSTRUCTION } = require(candidate) as ActivityInstructionModule;
      if (typeof ACTIVITY_INSTRUCTION === 'string' && ACTIVITY_INSTRUCTION.length > 0) {
        return ACTIVITY_INSTRUCTION;
      }
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    'Could not load ACTIVITY_INSTRUCTION from a built @librechat/api.\n' +
      'Build it first (from the repo root):\n' +
      '  npm run build:data-provider && npm run build:data-schemas && npm run build:api\n' +
      'Or point at an existing build:\n' +
      '  LABEL_EVAL_DIST=/path/to/packages/api/dist/index.cjs node scripts/activity-labels/run.mts',
  );
}

const ACTIVITY_INSTRUCTION = loadShippedInstruction();

const S = {
  role: 'You write the one-line header above a group of tool calls an AI agent just made.',
  register:
    'Write it like a git commit subject: past tense, verb first, leading with the most distinctive file, name, or finding.',
  outcome:
    'Say what the calls established or produced — the outcome, not the attempt. If they answered a question, the answer is the line.',
  prohibitions:
    'Never name the tools, never count them, never echo the arguments: the cards below the header already show all three.',
  format: 'Write 4 to 9 words, sentence case, no trailing punctuation, no quotes or markdown.',
  good: 'Good: "Confirmed /mnt/data resets between calls". "Traced the leak to formatAgentMessages". "Found 3 failing auth tests".',
  bad: 'Bad: "Ran 1 command". "Used bash_tool twice". "Executed ls /mnt/data". "Searched the codebase".',
  failure: 'If every call failed, say what failed and why, plainly.',
  output: 'Output only the line.',
};

const CONTINUITY_SENTENCE =
  'A "Previous headers" list may precede the batch: never restate one — if this batch continues that activity, say only what is new.';

/** Pre-P1 instruction — kept as the `legacy` variant for regression sweeps. */
const LEGACY_ORDER = [
  S.role,
  S.register,
  S.outcome,
  S.prohibitions,
  S.format,
  S.good,
  S.bad,
  S.failure,
  S.output,
];

/** The shipped instruction (P1): ordered structure + continuity clause. */
const SHIPPED_ORDER = [
  S.role,
  S.outcome,
  S.register,
  S.good,
  S.bad,
  S.failure,
  CONTINUITY_SENTENCE,
  S.prohibitions,
  S.format,
  S.output,
];

/** `baseline` is whatever the BUILT dist ships. Before the P1 rebuild that is
 *  the legacy order, after it the shipped order; anything else means the
 *  sentence table here has drifted and composed variants are stale. */
if (
  LEGACY_ORDER.join(' ') !== ACTIVITY_INSTRUCTION &&
  SHIPPED_ORDER.join(' ') !== ACTIVITY_INSTRUCTION
) {
  console.warn(
    'WARN: variants.mts sentence table has drifted from ACTIVITY_INSTRUCTION — composed variants are stale',
  );
}

const VERB_CHOICE =
  'Open with whichever past-tense verb the outcome dictates — confirmed, found, traced, measured, wrote, ruled out, failed — not the same verb every time.';
const DIVERSE_GOOD =
  'Good: "Traced the leak to formatAgentMessages". "Ruled out DNS as the failure cause". "Measured cold start at 412ms". "Found 3 failing auth tests".';
const CONTINUITY =
  'A "Previous headers" list may precede the batch: those lines already stand above earlier groups, so never write a line that merely restates one. If this batch continues that same activity, lead with what is new or different in THIS batch.';
const CONTINUITY_TIGHT =
  'A "Previous headers" list may precede the batch: never restate one — if this batch continues that activity, say only what is new.';
const FORMAT_HARD =
  'Write 4 to 9 words, sentence case, no trailing punctuation, no quotes or markdown; when a batch found many things, keep only the most load-bearing one or two.';

export const variants: Variant[] = [
  {
    name: 'baseline',
    usePreviousLabels: SHIPPED_ORDER.join(' ') === ACTIVITY_INSTRUCTION,
    instruction: ACTIVITY_INSTRUCTION,
  },
  {
    name: 'legacy',
    usePreviousLabels: false,
    instruction: LEGACY_ORDER.join(' '),
  },
  {
    name: 'verbs',
    usePreviousLabels: false,
    instruction: [
      S.role,
      S.register,
      VERB_CHOICE,
      S.outcome,
      S.prohibitions,
      S.format,
      DIVERSE_GOOD,
      S.bad,
      S.failure,
      S.output,
    ].join(' '),
  },
  {
    name: 'ordered',
    usePreviousLabels: false,
    instruction: [
      S.role,
      S.outcome,
      S.register,
      S.good,
      S.bad,
      S.failure,
      S.prohibitions,
      S.format,
      S.output,
    ].join(' '),
  },
  {
    name: 'continuity',
    usePreviousLabels: true,
    instruction: [
      S.role,
      S.register,
      S.outcome,
      S.prohibitions,
      S.format,
      S.good,
      S.bad,
      S.failure,
      CONTINUITY,
      S.output,
    ].join(' '),
  },
  {
    name: 'examples',
    usePreviousLabels: false,
    instruction: [
      S.role,
      S.register,
      S.outcome,
      S.prohibitions,
      S.format,
      DIVERSE_GOOD,
      S.bad,
      S.failure,
      S.output,
    ].join(' '),
  },
  {
    name: 'composed',
    usePreviousLabels: true,
    instruction: [
      S.role,
      S.outcome,
      S.register,
      DIVERSE_GOOD,
      S.bad,
      S.failure,
      CONTINUITY_TIGHT,
      S.prohibitions,
      FORMAT_HARD,
      S.output,
    ].join(' '),
  },
  {
    name: 'shipping-full',
    usePreviousLabels: true,
    /** Whole-run history instead of the 3-label recency window: does more
     *  story beat recency, or does it dilute the batch content? */
    previousLabelCap: Infinity,
    instruction: SHIPPED_ORDER.join(' '),
  },
  {
    name: 'shipping',
    usePreviousLabels: true,
    instruction: [
      S.role,
      S.outcome,
      S.register,
      S.good,
      S.bad,
      S.failure,
      CONTINUITY_TIGHT,
      S.prohibitions,
      S.format,
      S.output,
    ].join(' '),
  },
];
