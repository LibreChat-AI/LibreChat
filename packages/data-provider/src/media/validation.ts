import type {
  MediaCapability,
  MediaCondition,
  MediaEnumControl,
  MediaLimits,
  MediaNumberControl,
  MediaParameterName,
} from './capabilities';
import type {
  MediaImageParameters,
  MediaOptionValue,
  MediaSubmissionRequest,
  MediaVideoParameters,
  MediaInput,
} from './requests';

export type MediaValidationIssue = {
  code: 'unsupported' | 'invalid_request';
  field: MediaParameterName | 'inputs' | 'prompt';
  message: string;
};
type ValidationRequest = Pick<MediaSubmissionRequest, 'operation' | 'parameters'> & {
  prompt?: string;
  inputs: Array<MediaInput & { type?: string; bytes?: number }>;
};

/** Apply advertised defaults and compatible conditional choices without replacing explicit input. */
export function resolveMediaParameters(
  request: ValidationRequest,
  capability: MediaCapability,
  options: { optionalChoices?: boolean } = {},
): MediaImageParameters & MediaVideoParameters {
  const values = { ...request.parameters };
  const controls: Partial<
    Record<MediaParameterName, MediaNumberControl | MediaEnumControl | boolean | string[]>
  > = capability.controls;
  const explicit = request.parameters as Partial<Record<MediaParameterName, MediaOptionValue>>;
  const exactSize = !!explicit.size || (!controls.resolution && !!controls.size);
  for (const name of Object.keys(controls) as MediaParameterName[]) {
    if (explicit[name] !== undefined) continue;
    const control = controls[name];
    if (
      (name === 'size' && !exactSize) ||
      ((name === 'resolution' || name === 'aspectRatio') && exactSize)
    )
      continue;
    if (name === 'audio' && control === true && options.optionalChoices) {
      Object.assign(values, { audio: false });
      continue;
    }
    if (!control || typeof control !== 'object' || Array.isArray(control)) continue;
    const value =
      control.default ??
      (options.optionalChoices && !('min' in control) && !control.required
        ? control.values[0]
        : undefined);
    if (value !== undefined) Object.assign(values, { [name]: value });
  }
  for (const constraint of capability.constraints ?? []) {
    const effective = { ...request, parameters: values };
    if (
      constraint.when?.some((condition) => !matchesMediaCondition(effective, condition)) ||
      constraint.anyOf.some((condition) => matchesMediaCondition(effective, condition))
    )
      continue;
    const choice = constraint.anyOf.find(
      (condition) =>
        condition.kind === 'parameter' &&
        !condition.option &&
        condition.values?.length &&
        explicit[condition.name] === undefined,
    );
    if (choice?.kind === 'parameter') Object.assign(values, { [choice.name]: choice.values![0] });
  }
  return values;
}

export function matchesMediaCondition(request: ValidationRequest, condition: MediaCondition) {
  if (condition.kind === 'input') {
    const count = request.inputs.filter((input) => input.role === condition.role).length;
    return (
      count > 0 === condition.present &&
      (condition.min === undefined || count >= condition.min) &&
      (condition.max === undefined || count <= condition.max)
    );
  }
  const parameters = request.parameters as Partial<Record<MediaParameterName, MediaOptionValue>>;
  const value = condition.option
    ? request.parameters.providerOptions?.[condition.option]
    : parameters[condition.name];
  const present =
    value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== '');
  if (condition.present !== undefined && present !== condition.present) return false;
  if (condition.values) return condition.values.some((candidate) => candidate === value);
  return condition.present === false || present;
}

/** Shared catalog admission for the server, composer, comparisons and restored presets. */
export function validateMediaCapability(
  input: ValidationRequest,
  capability: MediaCapability,
  limits?: MediaLimits,
  options: { checkInputs?: boolean } = {},
): MediaValidationIssue[] {
  const request = { ...input, parameters: resolveMediaParameters(input, capability) };
  const issues: MediaValidationIssue[] = [];
  const add = (
    field: MediaValidationIssue['field'],
    message: string,
    code: MediaValidationIssue['code'] = 'unsupported',
  ) => issues.push({ field, message, code });
  if (capability.operation !== request.operation) add('inputs', 'This operation is not available.');
  if (
    request.prompt &&
    capability.maxPromptChars &&
    request.prompt.length > capability.maxPromptChars
  )
    add('prompt', 'The prompt exceeds this model’s supported length.', 'invalid_request');
  if (options.checkInputs !== false) {
    for (const item of request.inputs) {
      const mediaTypes = capability.inputs.mediaTypes?.[item.role];
      const maxBytes = capability.inputs.maxBytes?.[item.role];
      if (item.type && mediaTypes && !mediaTypes.includes(item.type))
        add('inputs', 'This media format is not supported by the selected model.');
      if (item.bytes !== undefined && maxBytes !== undefined && item.bytes > maxBytes)
        add('inputs', 'This input exceeds the selected model’s byte limit.', 'invalid_request');
    }
    if (
      request.inputs.length < capability.inputs.min ||
      request.inputs.length > capability.inputs.max ||
      (limits && request.inputs.length > limits.maxInputs) ||
      request.inputs.some((input) => !capability.inputs.roles.includes(input.role)) ||
      capability.inputs.requiredRoles?.some(
        (role) => !request.inputs.some((input) => input.role === role),
      )
    )
      add('inputs', 'These inputs are not supported.');
    if (
      request.inputs.some(
        (input) =>
          capability.inputs.hostedRoles?.some((role) => role === input.role) && !input.sourceURL,
      )
    )
      add('inputs', 'This input requires a hosted HTTPS media source.', 'invalid_request');
  }
  const controls: Partial<
    Record<MediaParameterName, MediaNumberControl | MediaEnumControl | boolean | string[]>
  > = capability.controls;
  const parameters = request.parameters as Partial<Record<MediaParameterName, MediaOptionValue>>;
  for (const name of Object.keys(controls) as MediaParameterName[]) {
    const control = controls[name];
    if (
      control &&
      typeof control === 'object' &&
      !Array.isArray(control) &&
      'required' in control &&
      control.required &&
      parameters[name] === undefined
    )
      add(name, `Choose a value for ${name}.`, 'invalid_request');
  }
  for (const name of Object.keys(parameters) as MediaParameterName[]) {
    const value = parameters[name];
    if (value === undefined) continue;
    const control = controls[name];
    if (control == null) {
      add(name, `Unsupported parameter: ${name}`);
      continue;
    }
    if (name === 'providerOptions') {
      const providerOptions = request.parameters.providerOptions;
      if (!Array.isArray(control) || !limits || !providerOptions) {
        add(name, 'Provider options are unavailable.');
        continue;
      }
      if (Object.keys(providerOptions).some((key) => !control.includes(key)))
        add(name, 'Unsupported provider options.');
      const pending: Array<{ value: MediaOptionValue; depth: number }> = [
        { value: providerOptions, depth: 0 },
      ];
      while (pending.length) {
        const item = pending.pop()!;
        if (item.depth > limits.maxProviderOptionDepth) {
          add(name, 'Provider options are too deeply nested.');
          break;
        }
        if (item.value && typeof item.value === 'object')
          for (const child of Object.values(item.value))
            pending.push({ value: child, depth: item.depth + 1 });
      }
      if (
        new TextEncoder().encode(JSON.stringify(providerOptions)).length >
        limits.maxProviderOptionBytes
      )
        add(name, 'Provider options exceed the configured byte limit.');
      continue;
    }
    if (name === 'negativePrompt') {
      if (
        control !== true ||
        typeof value !== 'string' ||
        (limits && value.length > limits.maxPromptChars)
      )
        add(name, 'Unsupported negative prompt.');
      continue;
    }
    if (Array.isArray(control)) add(name, 'Unsupported parameter control.');
    else if (typeof control === 'boolean') {
      if (!control || typeof value !== 'boolean') add(name, 'Unsupported boolean parameter.');
    } else if ('min' in control) {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < control.min ||
        value > control.max ||
        (control.values && !control.values.includes(value)) ||
        (['count', 'seed', 'outputCompression'].includes(name) && !Number.isInteger(value))
      )
        add(name, 'Parameter is outside the supported range.');
    } else if (!control.values.includes(String(value))) add(name, 'Unsupported parameter value.');
  }
  if (limits && request.parameters.count > limits.maxOutputs) add('count', 'Too many outputs.');
  if (parameters.background === 'transparent' && parameters.format === 'jpeg')
    add('format', 'JPEG cannot contain transparency.');
  if (
    parameters.size &&
    (parameters.resolution || (request.operation === 'video.generate' && parameters.aspectRatio))
  )
    add('size', 'Choose exact dimensions or a resolution and aspect ratio.');
  for (const constraint of capability.constraints ?? []) {
    if (
      options.checkInputs === false &&
      [...(constraint.when ?? []), ...constraint.anyOf].some(
        (condition) => condition.kind === 'input',
      )
    )
      continue;
    if (constraint.when?.some((condition) => !matchesMediaCondition(request, condition))) continue;
    if (constraint.anyOf.some((condition) => matchesMediaCondition(request, condition))) continue;
    for (const condition of constraint.anyOf)
      add(
        condition.kind === 'input' ? 'inputs' : condition.name,
        'This combination of inputs and settings is not supported.',
      );
  }
  return issues;
}
