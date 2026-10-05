import type { MediaCapability, MediaInput } from 'librechat-data-provider';

type Constraints = NonNullable<MediaCapability['constraints']>;
type MediaInputRole = MediaInput['role'];

/** First/last-frame mode excludes the provider's reference/clip mode. */
export function frameInputConstraints(
  exclusiveRoles: MediaInputRole[],
  options: { lastFrameRequiresFirst?: boolean } = {},
): Constraints {
  return [
    ...(options.lastFrameRequiresFirst === false
      ? []
      : ([
          {
            when: [{ kind: 'input', role: 'end_frame', present: true }],
            anyOf: [{ kind: 'input', role: 'start_frame', present: true }],
          },
        ] satisfies Constraints)),
    ...(['start_frame', 'end_frame'] as const).flatMap((frame) =>
      exclusiveRoles.map((role) => ({
        when: [{ kind: 'input' as const, role: frame, present: true }],
        anyOf: [{ kind: 'input' as const, role, present: false }],
      })),
    ),
  ];
}

export function maximumInputs(role: MediaInputRole, max: number): Constraints[number] {
  return {
    anyOf: [
      { kind: 'input', role, present: false },
      { kind: 'input', role, present: true, max },
    ],
  };
}
