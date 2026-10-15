import type { Dispatch, SetStateAction } from 'react';
import type { TFile } from 'librechat-data-provider';

/** The fields of a composer attachment a during-run submit reads. Hosts pass their own richer
 *  attachment type; the hooks keep it intact through the setter. */
export type ComposerFile = {
  file_id: string;
  temp_file_id?: string;
  type?: string;
  filepath?: string;
  filename?: string;
  width?: number;
  height?: number;
  size: number;
  progress: number;
  llmDeliveryPath?: TFile['llmDeliveryPath'];
};

/** Updates the composer's attachments, keyed by upload id. */
export type ComposerFileSetter<File extends ComposerFile> = Dispatch<
  SetStateAction<Map<string, File>>
>;
