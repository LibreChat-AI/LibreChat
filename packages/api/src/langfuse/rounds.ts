const MAX_TOOLS = 256;
const NAME_MAX_LENGTH = 256;

type Call = { name?: string | null };

function parse(input: unknown): unknown {
  if (typeof input !== 'string') {
    return input;
  }
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

/**
 * The tools a round called, from the round's own input. The SDK writes that
 * input as the list of calls the round ran, but leaves the whole graph state in
 * place when it finds none, so only a list whose every entry names a tool is
 * read, and only the names leave it: arguments and anything else recorded there
 * stay behind the deployment's content setting. The names are exact or absent: a
 * client checks them against the chat's own record of the round, which a
 * shortened list or a shortened name would fail for a round that matches.
 */
export function toolRoundNames(input: unknown): string[] | undefined {
  const calls = parse(input);
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_TOOLS) {
    return undefined;
  }
  const names: string[] = [];
  for (const call of calls as Array<Call | null>) {
    const name = call != null && typeof call === 'object' ? call.name : undefined;
    if (typeof name !== 'string' || name === '' || name.length > NAME_MAX_LENGTH) {
      return undefined;
    }
    names.push(name);
  }
  return names;
}
