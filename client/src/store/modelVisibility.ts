import type { ModelVisibility } from '~/utils/modelVisibility';
import { emptyModelVisibility } from '~/utils/modelVisibility';
import { createStorageAtom } from './jotai-utils';

/** Which providers and models the model selector offers, remembered per browser. */
export const modelVisibilityAtom = createStorageAtom<ModelVisibility>(
  'modelVisibility',
  emptyModelVisibility,
);
