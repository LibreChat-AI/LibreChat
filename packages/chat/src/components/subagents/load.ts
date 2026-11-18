/**
 * The panel is the one subagent surface that opens on demand, so it loads through a dynamic
 * import: exporting it statically would put its code in the components entry, which every page
 * loads. The app wraps this in its own lazy boundary.
 */
export function loadSubagentThreadPanel(): Promise<typeof import('./panel')> {
  return import('./panel');
}
