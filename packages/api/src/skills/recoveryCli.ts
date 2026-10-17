import { getSafeErrorMetadata } from '~/utils/errors';

interface RecoveryIntent {
  fileId: string;
  writerId: string;
  state: string;
  skillId: { toString(): string };
  cleanupHoldOwner?: string;
}

interface RecoveryResult {
  status: 'missing' | 'changed' | 'recovered';
  state?: 'committed' | 'abandoned';
}

type CleanupHoldRecoveryResult =
  | { status: 'missing' | 'changed' }
  | { status: 'recovered'; cleanup: boolean };

export interface SkillUploadRecoveryCliDeps {
  connect: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  runAsSystem: <T>(callback: () => Promise<T>) => Promise<T>;
  getIntent: (fileId: string) => Promise<RecoveryIntent | null>;
  listIntents: (skillId: string) => Promise<RecoveryIntent[]>;
  recoverStoppedIntent: (fileId: string, writerId: string) => Promise<RecoveryResult>;
  recoverStoppedCleanupHold: (
    fileId: string,
    holdOwner: string,
  ) => Promise<CleanupHoldRecoveryResult>;
  write: (message: string) => void;
  writeError: (message: string) => void;
}

const usage =
  'Usage: recover-skill-upload inspect-skill <skillId> | inspect <fileId> | recover <fileId> <writerId> --confirm-writers-drained | recover-cleanup <fileId> <holdOwner> --confirm-writers-drained. Stop or drain all Skill upload and sync writers before recovery.';

/** Operator entry point: the confirmation means all Skill upload and sync writers were drained. */
export async function runSkillUploadRecoveryCli(
  args: string[],
  deps: SkillUploadRecoveryCliDeps,
): Promise<number> {
  const [action, fileId, owner, confirmation] = args;
  const inspect = action === 'inspect' && args.length === 2 && Boolean(fileId);
  const inspectSkill = action === 'inspect-skill' && args.length === 2 && Boolean(fileId);
  const recover =
    action === 'recover' &&
    args.length === 4 &&
    Boolean(fileId) &&
    Boolean(owner) &&
    confirmation === '--confirm-writers-drained';
  const recoverCleanup =
    action === 'recover-cleanup' &&
    args.length === 4 &&
    Boolean(fileId) &&
    Boolean(owner) &&
    confirmation === '--confirm-writers-drained';
  if (args.length === 1 && (action === '--help' || action === '-h')) {
    deps.write(usage);
    return 0;
  }
  if (!inspect && !inspectSkill && !recover && !recoverCleanup) {
    deps.writeError(usage);
    return 2;
  }

  let connected = false;
  try {
    await deps.connect();
    connected = true;
    if (inspectSkill) {
      const intents = await deps.runAsSystem(() => deps.listIntents(fileId));
      deps.write(
        JSON.stringify(
          intents.map((intent) => ({
            fileId: intent.fileId,
            writerId: intent.writerId,
            skillId: intent.skillId.toString(),
            state: intent.state,
            cleanupHoldOwner: intent.cleanupHoldOwner,
          })),
        ),
      );
      return 0;
    }
    if (inspect) {
      const intent = await deps.runAsSystem(() => deps.getIntent(fileId));
      if (!intent) {
        deps.writeError(`No upload intent found for ${fileId}`);
        return 1;
      }
      deps.write(
        JSON.stringify({
          fileId: intent.fileId,
          writerId: intent.writerId,
          skillId: intent.skillId.toString(),
          state: intent.state,
          cleanupHoldOwner: intent.cleanupHoldOwner,
        }),
      );
      return 0;
    }

    if (recoverCleanup) {
      const result = await deps.runAsSystem(() => deps.recoverStoppedCleanupHold(fileId, owner));
      if (result.status !== 'recovered') {
        deps.writeError(
          `Upload cleanup hold ${fileId} was ${result.status}; inspect it again before retrying`,
        );
        return 1;
      }
      deps.write(
        result.cleanup
          ? `Recovered cleanup hold ${fileId}; cleanup queued`
          : `Recovered cleanup hold ${fileId}; file retained`,
      );
      return 0;
    }

    const result = await deps.runAsSystem(() => deps.recoverStoppedIntent(fileId, owner));
    if (result.status !== 'recovered') {
      deps.writeError(
        `Upload intent ${fileId} was ${result.status}; inspect it again before retrying`,
      );
      return 1;
    }
    deps.write(`Recovered ${fileId} as ${result.state}`);
    return 0;
  } finally {
    if (connected) await deps.disconnect();
  }
}

/** Keep operational errors at the process boundary without exposing driver details. */
export async function runSkillUploadRecoveryCommand(
  args: string[],
  deps: SkillUploadRecoveryCliDeps,
): Promise<number> {
  try {
    return await runSkillUploadRecoveryCli(args, deps);
  } catch (error) {
    deps.writeError(JSON.stringify(getSafeErrorMetadata(error)));
    return 1;
  }
}
