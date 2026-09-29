// image-record.mjs — the tested-image identity record, and how it crosses the runner→reporter
// process boundary (task 17.5, Req 5.12).
//
// run.mjs's stage 2 (resolveImage) produces one record naming the image both containers started
// from:
//
//   { reference, id, createdAt, provenance }
//
//   * reference  — the resolved tag (repository:tag), the configured ${HARNESS_IMAGE}.
//   * id         — the LOCAL image ID both containers start from (sha256 config digest; a locally
//                  built image has no repository digest, so this is what is reported).
//   * createdAt  — the image's creation time from its metadata, ISO 8601 UTC.
//   * provenance — 'built' when THIS run invoked a build, 'reused' when it did not.
//
// The stage-11 report is written by a SEPARATE process — the Layer B `jest` run — so the record has
// to travel the same channel Layer A's verdict does (layer-a-outcome.mjs): an environment variable on
// the child spawn, carrying a small JSON summary rather than anything large. This module owns that
// channel — the env-var name plus the serialize/parse pair — imported by BOTH the runner (which
// serializes it into the Layer B spawn) and reporter.mjs (which reads it back), so the two cannot
// disagree about the shape. The runner's OWN early-exit report needs no hand-off: it is written in the
// runner's process, which holds the record directly.
//
// NG1/NG2 hold: this carries the harness's own report metadata. It touches no application code and
// neither container-split script. No comparison between the image and the code, and no git (NG9,
// NG11): the record REPORTS what was tested.

// The provenance vocabulary, frozen. 'built' iff this run invoked a build; 'reused' otherwise —
// decided by which code path ran, never by comparing ids or timestamps (a cached build can return an
// existing id and an old creation time).
export const IMAGE_PROVENANCE = Object.freeze({
  BUILT: 'built',
  REUSED: 'reused',
});

const ALL_PROVENANCE = Object.freeze(Object.values(IMAGE_PROVENANCE));

// The environment variable through which run.mjs hands the image record to the Layer B Jest run, so
// the stage-11 reporter can write the `image` block. Absent on a plain `npx jest` invocation, where
// no runner resolved an image and the reporter must claim none.
export const IMAGE_RECORD_ENV = 'HARNESS_IMAGE_RECORD';

// Whether a value is a well-formed image record — the four fields, with `reference` and `provenance`
// the two that must be present and valid (id/createdAt may be null when an inspect produced no usable
// line, which is reported as such rather than fabricated). Pure, so both the serializer and the
// reader gate on the same rule.
export function isImageRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.reference === 'string' &&
    value.reference.trim() !== '' &&
    ALL_PROVENANCE.includes(value.provenance) &&
    (value.id === null || typeof value.id === 'string') &&
    (value.createdAt === null || typeof value.createdAt === 'string')
  );
}

// Serialize the image record for the environment hand-off. Returns the JSON string, or null for a
// null/absent record (a run that ended before image resolution), so the caller omits the env var
// entirely rather than passing an empty one.
export function serializeImageRecord(image) {
  if (!isImageRecord(image)) {
    return null;
  }
  return JSON.stringify({
    reference: image.reference,
    id: image.id ?? null,
    createdAt: image.createdAt ?? null,
    provenance: image.provenance,
  });
}

// Read the image record back out of an environment map. Returns null when the variable is absent or
// unparseable — the plain `npx jest` case, where no runner resolved an image and the reporter must
// NOT claim one. A malformed value reads as absent rather than throwing: the record is a report field,
// and losing it must not unwind the reporter.
export function readImageRecord(env = process.env) {
  const raw = env?.[IMAGE_RECORD_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return isImageRecord(parsed)
      ? {
          reference: parsed.reference,
          id: parsed.id ?? null,
          createdAt: parsed.createdAt ?? null,
          provenance: parsed.provenance,
        }
      : null;
  } catch {
    return null;
  }
}
