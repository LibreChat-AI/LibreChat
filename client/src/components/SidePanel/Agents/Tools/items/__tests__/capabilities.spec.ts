import { AgentCapabilities, EToolResources, Tools } from 'librechat-data-provider';
import type { AgentForm, TAgentOption } from '~/common';
import {
  countCapabilityFiles,
  FILE_BACKED_CAPABILITIES,
  isFileBackedCapabilityEnabled,
  requiresFileManagerRemoval,
  resolveCapabilityTools,
} from '../capabilities';

const fileEntry = (id: string) => [id, { file_id: id }] as [string, never];

const agentWith = (overrides: Partial<TAgentOption> = {}): TAgentOption =>
  ({ id: 'agent_1', ...overrides }) as TAgentOption;

const formWith = (overrides: Partial<AgentForm> = {}): AgentForm =>
  ({ id: 'agent_1', tools: [], ...overrides }) as AgentForm;

const knowledge = FILE_BACKED_CAPABILITIES.find(
  (entry) => entry.capability === AgentCapabilities.file_search,
)!;

describe('countCapabilityFiles', () => {
  it('counts the hydrated form entries', () => {
    const agent = agentWith({ knowledge_files: [fileEntry('f1'), fileEntry('f2')] });

    expect(countCapabilityFiles(agent, knowledge)).toBe(2);
  });

  it('falls back to persisted ids before the file map hydrates', () => {
    const agent = agentWith({
      tool_resources: { [EToolResources.file_search]: { file_ids: ['f1', 'f2', 'f3'] } },
    });

    expect(countCapabilityFiles(agent, knowledge)).toBe(3);
  });

  it('prefers hydrated entries over persisted ids', () => {
    const agent = agentWith({
      knowledge_files: [fileEntry('f1')],
      tool_resources: { [EToolResources.file_search]: { file_ids: ['f1', 'f2', 'f3'] } },
    });

    expect(countCapabilityFiles(agent, knowledge)).toBe(1);
  });

  it('reports no files for an agent that holds none', () => {
    expect(countCapabilityFiles(agentWith(), knowledge)).toBe(0);
    expect(countCapabilityFiles(undefined, knowledge)).toBe(0);
  });
});

describe('isFileBackedCapabilityEnabled', () => {
  it('is on when the flag is set', () => {
    expect(isFileBackedCapabilityEnabled(true, 0)).toBe(true);
  });

  it('is on when files are attached without the flag', () => {
    expect(isFileBackedCapabilityEnabled(false, 1)).toBe(true);
    expect(isFileBackedCapabilityEnabled(undefined, 1)).toBe(true);
  });

  it('is off only with neither', () => {
    expect(isFileBackedCapabilityEnabled(false, 0)).toBe(false);
    expect(isFileBackedCapabilityEnabled(undefined, 0)).toBe(false);
  });
});

describe('resolveCapabilityTools', () => {
  it('persists file_search for an agent holding knowledge files with the flag cleared', () => {
    const data = formWith({
      [AgentCapabilities.file_search]: false,
      agent: agentWith({ knowledge_files: [fileEntry('f1')] }),
    });

    expect(resolveCapabilityTools(data)).toContain(Tools.file_search);
  });

  it('persists file_search from the flag alone before any file is attached', () => {
    const data = formWith({ [AgentCapabilities.file_search]: true, agent: agentWith() });

    expect(resolveCapabilityTools(data)).toEqual([Tools.file_search]);
  });

  it('persists execute_code for an agent holding code files with the flag cleared', () => {
    const data = formWith({
      [AgentCapabilities.execute_code]: false,
      agent: agentWith({ code_files: [fileEntry('c1')] }),
    });

    expect(resolveCapabilityTools(data)).toContain(Tools.execute_code);
  });

  it('resolves file-backed capabilities from the unhydrated agent document', () => {
    const data = formWith({
      [AgentCapabilities.file_search]: false,
      agent: agentWith({
        tool_resources: { [EToolResources.file_search]: { file_ids: ['f1'] } },
      }),
    });

    expect(resolveCapabilityTools(data)).toContain(Tools.file_search);
  });

  it('omits capabilities that are neither enabled nor backed by files', () => {
    expect(resolveCapabilityTools(formWith({ agent: agentWith() }))).toEqual([]);
  });

  it('persists flag-only capabilities from their flag alone', () => {
    const data = formWith({
      [AgentCapabilities.web_search]: true,
      [AgentCapabilities.memory]: true,
      agent: agentWith(),
    });

    expect(resolveCapabilityTools(data)).toEqual([Tools.web_search, Tools.memory]);
  });

  it('does not resurrect a flag-only capability from attached files', () => {
    const data = formWith({
      [AgentCapabilities.web_search]: false,
      agent: agentWith({ knowledge_files: [fileEntry('f1')] }),
    });

    expect(resolveCapabilityTools(data)).not.toContain(Tools.web_search);
  });
});

describe('requiresFileManagerRemoval', () => {
  const counts = (knowledge = 0, code = 0) => ({
    knowledge_files: knowledge,
    code_files: code,
  });

  it('routes a file-holding capability to the file manager', () => {
    expect(requiresFileManagerRemoval(AgentCapabilities.file_search, counts(1))).toBe(true);
    expect(requiresFileManagerRemoval(AgentCapabilities.execute_code, counts(0, 1))).toBe(true);
  });

  it('lets a capability with no files be switched off by its flag', () => {
    expect(requiresFileManagerRemoval(AgentCapabilities.file_search, counts())).toBe(false);
    expect(requiresFileManagerRemoval(AgentCapabilities.execute_code, counts(1))).toBe(false);
  });

  it('always routes the file-only context built-in to the file manager', () => {
    expect(requiresFileManagerRemoval(EToolResources.context, counts())).toBe(true);
  });

  it('leaves flag-only built-ins alone', () => {
    expect(requiresFileManagerRemoval(AgentCapabilities.web_search, counts(1, 1))).toBe(false);
    expect(requiresFileManagerRemoval('artifacts', counts(1, 1))).toBe(false);
  });
});

describe('display and persistence agree', () => {
  /** The reported bug: the builder showed File Search as selected off the file count
   *  while the save wrote it off the flag alone, so it was dropped from an agent that
   *  still listed its knowledge files. Both sides now read the same rule. */
  it.each([
    [true, 0],
    [false, 1],
    [true, 1],
    [false, 0],
  ])('flag=%s files=%s', (flag, fileCount) => {
    const displayed = isFileBackedCapabilityEnabled(flag, fileCount);
    const persisted = resolveCapabilityTools(
      formWith({
        [AgentCapabilities.file_search]: flag,
        agent: agentWith({
          knowledge_files: Array.from({ length: fileCount }, (_, i) => fileEntry(`f${i}`)),
        }),
      }),
    ).includes(Tools.file_search);

    expect(persisted).toBe(displayed);
  });
});
