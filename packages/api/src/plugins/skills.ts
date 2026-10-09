import fs from 'fs';
import path from 'path';
import type { DeploymentSkill } from '~/skills';
import type { PluginDiagnostic } from './types';
import { PLUGIN_SKILLS_DIR, SKILL_MANIFEST_FILE } from './constants';
import { loadSkillFromDirectory } from '~/skills';
import { resolveWithinRoot } from './paths';

export interface PluginSkillsResult {
  skills: DeploymentSkill[];
  diagnostics: PluginDiagnostic[];
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isRegularFile(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * Agent Plugins §7.1: each immediate child of `skills/` holding a regular
 * `SKILL.md` is one skill. Deeper descendants are never searched, and a skill
 * that fails validation is skipped rather than failing the plugin.
 */
export async function loadPluginSkills(
  realRoot: string,
  pluginName: string,
): Promise<PluginSkillsResult> {
  const diagnostics: PluginDiagnostic[] = [];
  const skillsRoot = await resolveWithinRoot(realRoot, PLUGIN_SKILLS_DIR);
  if (skillsRoot === null) {
    return {
      skills: [],
      diagnostics: [
        {
          code: 'path_escape',
          severity: 'warning',
          message: `"${PLUGIN_SKILLS_DIR}/" resolves outside the plugin root; skills were not loaded`,
          location: PLUGIN_SKILLS_DIR,
        },
      ],
    };
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { skills: [], diagnostics };
    }
    return {
      skills: [],
      diagnostics: [
        {
          code: 'component_location_invalid',
          severity: 'warning',
          message: `"${PLUGIN_SKILLS_DIR}/" could not be read as a directory`,
          location: PLUGIN_SKILLS_DIR,
        },
      ],
    };
  }

  const skills: DeploymentSkill[] = [];
  const seenNames = new Set<string>();

  for (const entry of entries) {
    const candidate = path.join(skillsRoot, entry.name);
    if (!(await isDirectory(candidate))) {
      continue;
    }
    const relativeDirectory = `${PLUGIN_SKILLS_DIR}/${entry.name}`;
    const manifestPath = await resolveWithinRoot(
      realRoot,
      path.join(PLUGIN_SKILLS_DIR, entry.name, SKILL_MANIFEST_FILE),
    );
    if (manifestPath === null) {
      diagnostics.push({
        code: 'path_escape',
        severity: 'warning',
        message: `${SKILL_MANIFEST_FILE} resolves outside the plugin root; the skill was skipped`,
        location: relativeDirectory,
      });
      continue;
    }
    if (!(await isRegularFile(manifestPath))) {
      continue;
    }

    try {
      const skill = await loadSkillFromDirectory(
        { directory: candidate, relativeDirectory },
        realRoot,
        {
          idNamespace: `plugin-skill:${pluginName}`,
          plugin: pluginName,
        },
      );
      if (seenNames.has(skill.name)) {
        diagnostics.push({
          code: 'skill_invalid',
          severity: 'warning',
          message: `Skill "${skill.name}" is declared more than once in this plugin; the later directory was skipped`,
          location: relativeDirectory,
        });
        continue;
      }
      seenNames.add(skill.name);
      skills.push(skill);
    } catch (error) {
      diagnostics.push({
        code: 'skill_invalid',
        severity: 'warning',
        message: error instanceof Error ? error.message : String(error),
        location: relativeDirectory,
      });
    }
  }

  return { skills, diagnostics };
}
