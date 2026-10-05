import type { MediaOwnerScope } from './media';

export interface MediaTitleMethods {
  claimMediaThreadTitle(input: {
    scope: MediaOwnerScope;
    jobId: string;
    threadId: string;
    expectedTitle: string;
  }): Promise<boolean>;
}
