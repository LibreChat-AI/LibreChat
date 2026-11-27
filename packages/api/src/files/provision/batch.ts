import type { FileStorageUploadObserver } from '../operations';

export interface UploadBatchMember<R> {
  /** Joins the shared request from inside the member's own storage claim. */
  upload: (onUploadStart: FileStorageUploadObserver) => Promise<R>;
  /** Marks the member's provisioning finished; one that never joined stops being awaited. */
  release: () => void;
}

interface JoinedMember<T, R> {
  index: number;
  entry: T;
  onUploadStart: FileStorageUploadObserver;
  resolve: (value: R) => void;
  reject: (reason: unknown) => void;
}

/**
 * Lets files that each hold their own storage claim share one upload request.
 *
 * The request is sent once every member has either joined or finished without uploading, so a
 * member whose claim was denied, or whose upload another caller already owns, never holds the
 * rest back. `dispatch` receives the joined members in entry order and settles them in that
 * same order.
 */
export function createUploadBatch<T, R>(
  entries: readonly T[],
  dispatch: (
    joined: Array<{ entry: T; onUploadStart: FileStorageUploadObserver }>,
  ) => Promise<Array<PromiseSettledResult<R>>>,
): UploadBatchMember<R>[] {
  const joined: JoinedMember<T, R>[] = [];
  let undecided = entries.length;

  const decide = (): void => {
    undecided--;
    if (undecided > 0 || joined.length === 0) {
      return;
    }
    const members = [...joined].sort((a, b) => a.index - b.index);
    Promise.resolve()
      .then(() => dispatch(members.map(({ entry, onUploadStart }) => ({ entry, onUploadStart }))))
      .then(
        (results) => {
          for (let i = 0; i < members.length; i++) {
            const result = results[i];
            if (result?.status === 'fulfilled') {
              members[i].resolve(result.value);
            } else {
              members[i].reject(result?.reason ?? new Error('Upload batch returned no result'));
            }
          }
        },
        (error: unknown) => {
          for (const member of members) member.reject(error);
        },
      );
  };

  return entries.map((entry, index) => {
    let decided = false;
    return {
      upload: (onUploadStart) =>
        new Promise<R>((resolve, reject) => {
          if (decided) {
            reject(new Error('Upload batch member has already settled'));
            return;
          }
          decided = true;
          joined.push({ index, entry, onUploadStart, resolve, reject });
          decide();
        }),
      release: () => {
        if (decided) {
          return;
        }
        decided = true;
        decide();
      },
    };
  });
}
