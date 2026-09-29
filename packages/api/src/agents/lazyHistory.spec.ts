import { Types } from 'mongoose';
import { createLazyAgentHistoryResolver } from './lazyHistory';

const userId = new Types.ObjectId().toString();

function makeResolver(options: { skillId: Types.ObjectId; disabled?: boolean; active?: boolean }) {
  const { skillId, disabled = false, active = true } = options;
  return createLazyAgentHistoryResolver({
    accessibleSkillIds: [skillId],
    editableSkillIds: [],
    skillsCapabilityEnabled: true,
    ephemeralSkillsToggle: false,
    userId,
    skillStates: { [skillId.toString()]: active },
    listSkillsByAccess: async () => ({
      skills: [
        {
          _id: skillId,
          name: 'analysis',
          description: 'Analyze carefully.',
          author: new Types.ObjectId(userId),
          disableModelInvocation: disabled,
        },
      ],
    }),
    listAlwaysApplySkills: async () => ({ skills: [] }),
    deferredToolsAvailable: false,
    programmaticToolsAvailable: false,
    backgroundToolsAvailable: false,
  });
}

const agent = {
  id: `agent_${new Types.ObjectId().toString()}`,
  skills_enabled: true,
  skills: [],
  tools: [],
};

describe('createLazyAgentHistoryResolver', () => {
  it('omits Skill tools when every scoped skill is inactive', async () => {
    const metadata = await makeResolver({
      skillId: new Types.ObjectId(),
      active: false,
    }).resolve({ agent, codeExecutionAvailable: false, memoryAvailable: false });

    expect(metadata.historicalToolNames).not.toContain('skill');
    expect(metadata.historicalToolNames).not.toContain('read_file');
  });

  it('keeps read_file but omits skill when only non-model-invocable skills are active', async () => {
    const metadata = await makeResolver({
      skillId: new Types.ObjectId(),
      disabled: true,
    }).resolve({ agent, codeExecutionAvailable: false, memoryAvailable: false });

    expect(metadata.historicalToolNames).not.toContain('skill');
    expect(metadata.historicalToolNames).toContain('read_file');
  });

  it('keeps skill and read_file when the active catalog is model-visible', async () => {
    const metadata = await makeResolver({ skillId: new Types.ObjectId() }).resolve({
      agent,
      codeExecutionAvailable: false,
      memoryAvailable: false,
    });

    expect(metadata.historicalToolNames).toEqual(expect.arrayContaining(['skill', 'read_file']));
  });

  it('preserves the resolved skill-authoring capability for lazy admission', async () => {
    const skillId = new Types.ObjectId();
    const resolver = createLazyAgentHistoryResolver({
      accessibleSkillIds: [skillId],
      editableSkillIds: [skillId],
      skillsCapabilityEnabled: true,
      ephemeralSkillsToggle: false,
      userId,
      listSkillsByAccess: async () => ({ skills: [] }),
      listAlwaysApplySkills: async () => ({ skills: [] }),
      canAuthorSkillFiles: () => true,
      deferredToolsAvailable: false,
      programmaticToolsAvailable: false,
      backgroundToolsAvailable: false,
    });

    await expect(
      resolver.resolve({ agent, codeExecutionAvailable: true, memoryAvailable: false }),
    ).resolves.toEqual(expect.objectContaining({ skillAuthoringAvailable: true }));
  });
});
