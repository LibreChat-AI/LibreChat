/**
 * Runs the domain admission `check` unless the caller already admitted this server's
 * domain for the current call, so a batch of tools from one server pays for it once.
 */
export async function reuseMCPAdmission(
  admitted: boolean | undefined,
  check: () => Promise<boolean>,
): Promise<boolean> {
  return admitted === true ? true : check();
}
