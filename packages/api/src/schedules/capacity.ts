/** Occupancy of the global scheduled-run capacity slots. `unslotted` counts legacy
 *  `started` rows written before slots existed; they shrink the effective cap so the
 *  bound stays conservative during rollout instead of transiently overshooting. */
export interface CapacityOccupancy {
  takenSlots: number[];
  unslotted: number;
}

/** A claim either succeeded (carrying the caller's own result) or lost the slot race. */
export type SlotClaimResult<T> = { claimed: T } | 'slot-taken';

/**
 * Allocates the lowest free global capacity slot and hands it to `claim`, retrying the
 * next free slot when the DB rejects a collision on the unique partial index.
 *
 * This replaces "count active runs, compare to the cap, then insert": the count is a
 * read-then-write race, so two admissions of DIFFERENT schedules could both observe
 * cap-1 and both proceed. Here the slot itself is the contended resource and the
 * unique index is the arbiter, so the cap is enforced by the database.
 *
 * Bounded by cap+1 attempts: every collision advances to a strictly higher free slot.
 */
export async function withCapacitySlot<T>(
  cap: number,
  readOccupancy: () => Promise<CapacityOccupancy>,
  claim: (slot: number) => Promise<SlotClaimResult<T>>,
): Promise<{ claimed: T } | 'capacity'> {
  if (cap <= 0) {
    return 'capacity';
  }
  for (let attempt = 0; attempt <= cap; attempt++) {
    const { takenSlots, unslotted } = await readOccupancy();
    if (takenSlots.length + unslotted >= cap) {
      return 'capacity';
    }
    const taken = new Set(takenSlots);
    let slot = -1;
    for (let candidate = 0; candidate < cap; candidate++) {
      if (!taken.has(candidate)) {
        slot = candidate;
        break;
      }
    }
    if (slot < 0) {
      return 'capacity';
    }
    const result = await claim(slot);
    if (result !== 'slot-taken') {
      return result;
    }
  }
  return 'capacity';
}
