/** A verified generation snapshot may temporarily be unavailable while terminal writes settle.
 * Treat only the protocol's explicit readiness response as pending, never an arbitrary failure. */
export async function readGenerationStatus(response) {
  if (response.ok()) return response.json();
  if (response.status() === 503) {
    const body = await response.json().catch(() => null);
    if (body?.code === 'SERVER_NOT_READY') return { active: true };
  }
  throw new Error(`Generation status request failed with HTTP ${response.status()}`);
}
