/** Already MIME/size-screened files spend the shared allowance once before priming. */
export function admitCurrentFileBudget<T extends { file_id?: string; bytes?: number }>(
  files: T[],
  totalSizeLimit?: number,
): T[] {
  const admitted: T[] = [];
  const seen = new Set<string>();
  let consumed = 0;
  for (const file of files) {
    if (file.file_id != null) {
      if (seen.has(file.file_id)) continue;
      seen.add(file.file_id);
    }
    const bytes = file.bytes ?? 0;
    if (totalSizeLimit != null && totalSizeLimit > 0 && consumed + bytes > totalSizeLimit) {
      continue;
    }
    admitted.push(file);
    consumed += bytes;
  }
  return admitted;
}
