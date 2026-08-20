import fs from 'fs-extra';
import path from 'path';
import pc from 'picocolors';
import {
  Agent,
  DEFAULT_WORKFLOWS,
  INTERNAL_ONLY_WORKFLOWS,
  SUPPORTED_AGENTS,
} from '../constants';
import { SkillConfig } from '../models/config';
import { CollectedSkill } from '../models/types';
import { GithubService } from './GithubService';
import { WorkflowTransformer } from './utils/WorkflowTransformer';

/**
 * Service responsible for synchronizing agent workflows from a remote registry.
 */
export class WorkflowSyncService {
  constructor(private githubService: GithubService) {}

  /**
   * Reconciles workflows by discovering new ones in the registry and adding them to the config.
   */
  async reconcileWorkflows(config: SkillConfig): Promise<boolean> {
    if (config.workflows === false) return false;

    const githubMatch = GithubService.parseGitHubUrl(config.registry);
    if (!githubMatch) return false;

    const { owner, repo } = githubMatch;
    const ref =
      (await this.githubService.getRepoInfo(owner, repo))?.default_branch ||
      'main';

    const treeData = await this.githubService.getRepoTree(owner, repo, ref);
    if (!treeData) return false;

    const availableWorkflows = treeData.tree
      .filter((f) => this.isWorkflowMarkdownPath(f.path))
      .map((f) => this.workflowNameFromPath(f.path))
      .filter((wf) => !INTERNAL_ONLY_WORKFLOWS.includes(wf));

    if (availableWorkflows.length === 0) return false;

    let changed = false;

    if (Array.isArray(config.workflows)) {
      const currentWorkflows = config.workflows as string[];
      const newWorkflows = availableWorkflows.filter(
        (wf) =>
          !currentWorkflows.includes(wf) && DEFAULT_WORKFLOWS.includes(wf),
      );

      if (newWorkflows.length > 0) {
        config.workflows = [...currentWorkflows, ...newWorkflows];
        console.log(
          pc.yellow(
            `✨ Workflows Discovered: Adding [${newWorkflows.join(', ')}] to .skillsrc.`,
          ),
        );
        changed = true;
      }
    } else if (config.workflows === undefined) {
      const defaultWorkflows = availableWorkflows.filter((wf) =>
        DEFAULT_WORKFLOWS.includes(wf),
      );
      config.workflows = defaultWorkflows;
      console.log(
        pc.yellow(
          `✨ Workflows Initialized: Adding [${defaultWorkflows.join(', ')}] to .skillsrc.`,
        ),
      );
      changed = true;
    } else if (config.workflows === true) {
      // If it's true, we keep it true to sync everything from the registry.
      // We don't overwrite it with the default list.
      const newWorkflows = availableWorkflows.filter(
        (wf) => !DEFAULT_WORKFLOWS.includes(wf),
      );
      if (newWorkflows.length > 0) {
        console.log(
          pc.cyan(
            `ℹ️  Registry has ${availableWorkflows.length} workflows (including ${newWorkflows.length} non-default). Syncing all because 'workflows: true' is set.`,
          ),
        );
      }
    }

    return changed;
  }

  /**
   * Assembles workflows from the remote registry.
   */
  async assembleWorkflows(config: SkillConfig): Promise<CollectedSkill[]> {
    if (!config.workflows) return [];

    const githubMatch = GithubService.parseGitHubUrl(config.registry);
    if (!githubMatch) return [];

    const { owner, repo } = githubMatch;
    const ref =
      (await this.githubService.getRepoInfo(owner, repo))?.default_branch ||
      'main';

    console.log(pc.gray(`  - Discovering workflows (${ref})...`));

    const treeData = await this.githubService.getRepoTree(owner, repo, ref);
    if (!treeData) {
      console.log(pc.red(`    ❌ Failed to fetch workflows@${ref}.`));
      return [];
    }

    const workflowFiles = treeData.tree.filter((f) => {
      if (!this.isWorkflowMarkdownPath(f.path)) return false;
      // Internal-only workflows are never synced to a consumer project, even
      // with `workflows: true` or an explicit entry in the array — they
      // depend on this monorepo's own root tooling and would be non-functional
      // anywhere else.
      if (INTERNAL_ONLY_WORKFLOWS.includes(this.workflowNameFromPath(f.path))) {
        return false;
      }

      if (typeof config.workflows === 'boolean') return config.workflows;
      if (Array.isArray(config.workflows)) {
        return config.workflows.includes(this.workflowNameFromPath(f.path));
      }
      return false;
    });

    const files = await this.githubService.downloadFilesConcurrent(
      workflowFiles.map((f) => ({ owner, repo, ref, path: f.path })),
    );

    if (files.length > 0) {
      console.log(pc.gray(`    + Fetched ${files.length} workflows`));
      return [
        {
          category: '.agents',
          skill: 'workflows',
          files: files.map((f) => ({
            name: path.basename(f.path),
            content: f.content,
          })),
        },
      ];
    } else {
      if (workflowFiles.length > 0) {
        console.log(
          pc.red(
            `    ❌ Failed to download ${workflowFiles.length} matched workflows.`,
          ),
        );
      } else {
        console.log(
          pc.gray(`    ℹ️  No matching workflows found in registry.`),
        );
      }
    }

    return [];
  }

  /**
   * Assembles workflows from the registry checkout on disk without using GitHub.
   */
  async assembleWorkflowsLocal(
    config: SkillConfig,
    rootDir = process.cwd(),
  ): Promise<CollectedSkill[]> {
    if (!config.workflows) return [];

    const workflowsDir = path.join(rootDir, '.agents', 'workflows');
    if (!(await fs.pathExists(workflowsDir))) {
      console.log(pc.yellow('    ⚠️  Local workflows directory not found.'));
      return [];
    }

    const entries = (await fs.readdir(workflowsDir)).sort();
    const matched = entries.filter((entry) => {
      const workflowPath = path.posix.join('.agents', 'workflows', entry);
      if (!this.isWorkflowMarkdownPath(workflowPath)) return false;
      const workflowName = this.workflowNameFromPath(workflowPath);
      if (INTERNAL_ONLY_WORKFLOWS.includes(workflowName)) return false;
      return (
        config.workflows === true ||
        (Array.isArray(config.workflows) &&
          config.workflows.includes(workflowName))
      );
    });

    if (matched.length === 0) return [];
    const files = await Promise.all(
      matched.map(async (name) => ({
        name,
        content: await fs.readFile(path.join(workflowsDir, name), 'utf8'),
      })),
    );
    return [{ category: '.agents', skill: 'workflows', files }];
  }

  /**
   * Writes collected workflows from `.agents/workflows/*.md` to each active
   * agent's native invocation surface.
   * - Antigravity/Kiro: keep native markdown workflows
   * - Claude/Roo/OpenCode: markdown command files
   * - Gemini: TOML command files
   * - Copilot: prompt files
   * - Cursor/Trae/Codex: skill folders with SKILL.md
   */
  /**
   * Warns when a workflow instructs the agent to load a skill that this project
   * will not have.
   *
   * Workflows reference skills by id in backticks (``` `common-security-audit` ```).
   * `.skillsrc` can exclude a skill from the install, but the workflow copy is
   * verbatim -- so the reference survives as a permanently dangling instruction
   * that silently no-ops at runtime. Only tokens prefixed with a configured
   * category are considered, so ordinary prose and workflow names
   * (`design-solution`, `semi-trusted`) are not flagged.
   *
   * @param availableSkills When supplied, also warns on ids absent from the
   *   registry entirely, not just deliberately excluded ones.
   */
  validateSkillReferences(
    workflows: CollectedSkill[],
    config: SkillConfig,
    availableSkills?: Set<string>,
  ): string[] {
    const categories = Object.keys(config.skills || {});
    if (categories.length === 0) return [];

    const excluded = new Map<string, string>();
    for (const category of categories) {
      for (const skill of config.skills[category]?.exclude || []) {
        excluded.set(skill, category);
      }
    }

    const warnings: string[] = [];
    const seen = new Set<string>();

    for (const wf of workflows) {
      for (const fileItem of wf.files) {
        const tokens = fileItem.content.match(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g) || [];
        for (const raw of tokens) {
          const id = raw.slice(1, -1);
          const category = categories.find((c) => id.startsWith(`${c}-`));
          if (!category) continue;

          const key = `${fileItem.name}:${id}`;
          if (seen.has(key)) continue;
          seen.add(key);

          if (excluded.has(id)) {
            warnings.push(
              `${fileItem.name} loads \`${id}\`, excluded from \`${category}\` in .skillsrc`,
            );
          } else if (availableSkills && !availableSkills.has(id)) {
            warnings.push(
              `${fileItem.name} loads \`${id}\`, which is not in the registry`,
            );
          }
        }
      }
    }

    return warnings;
  }

  async writeWorkflows(
    workflows: CollectedSkill[],
    config: SkillConfig,
    agents?: Agent[],
    availableSkills?: Set<string>,
  ) {
    if (workflows.length === 0) return;

    const referenceWarnings = this.validateSkillReferences(
      workflows,
      config,
      availableSkills,
    );
    if (referenceWarnings.length > 0) {
      console.log(
        pc.yellow(
          `  ⚠️  ${referenceWarnings.length} workflow reference(s) point at unavailable skills:`,
        ),
      );
      for (const warning of referenceWarnings) {
        console.log(pc.yellow(`     - ${warning}`));
      }
    }

    const overrides = config.custom_overrides || [];
    const targetAgents = agents || [Agent.Antigravity];

    for (const agentId of targetAgents) {
      const agentDef = SUPPORTED_AGENTS.find((a) => a.id === agentId);
      if (!agentDef || agentDef.workflowFormat === 'none') continue;

      const workflowDir = path.join(process.cwd(), agentDef.workflowPath);
      await fs.ensureDir(workflowDir);

      // Calculate relative path from workflow dir to the source workflow files (.agents/workflows)
      // This is used by Gemini (TOML) to reference the canonical markdown source.
      let written = 0;
      for (const wf of workflows) {
        if (wf.skill !== 'workflows') continue;

        for (const fileItem of wf.files) {
          const parsed = WorkflowTransformer.parse({
            name: fileItem.name,
            content: fileItem.content,
          });
          const transformed = WorkflowTransformer.transformParsed(
            parsed,
            agentDef.workflowFormat,
          );
          if (!transformed) continue;

          let targetFilePath: string;
          if (agentDef.workflowFormat === 'skill') {
            const workflowName = fileItem.name.replace(/\.md$/, '');
            targetFilePath = path.join(
              workflowDir,
              workflowName,
              transformed.name,
            );
          } else {
            targetFilePath = path.join(workflowDir, transformed.name);
          }

          if (!this.isPathSafe(targetFilePath, workflowDir)) {
            console.log(
              pc.red(`    ❌ Security Error: Invalid path ${targetFilePath}`),
            );
            continue;
          }

          if (this.isOverridden(targetFilePath, overrides)) {
            continue;
          }

          await fs.outputFile(targetFilePath, transformed.content);
          written++;
        }
      }

      if (written > 0) {
        console.log(
          pc.green(
            `  ✅ ${written} workflows synced to ${agentDef.workflowPath}/ (${agentDef.name})`,
          ),
        );
      }
    }
  }

  private isPathSafe(targetPath: string, subPath: string): boolean {
    const resolvedBase = path.resolve(subPath) + path.sep;
    return path.resolve(targetPath).startsWith(resolvedBase);
  }

  private isWorkflowMarkdownPath(workflowPath: string): boolean {
    return (
      path.posix.dirname(workflowPath) === '.agents/workflows' &&
      workflowPath.endsWith('.md')
    );
  }

  private workflowNameFromPath(workflowPath: string): string {
    return path.basename(workflowPath, '.md');
  }

  private isOverridden(targetPath: string, overrides: string[]): boolean {
    const rel = this.normalizePath(targetPath);
    return overrides.some((o) => {
      const op = o.replace(/\\/g, '/').replace(/\/$/, '');
      return (
        rel === op ||
        rel.startsWith(`${op}/`) ||
        rel.includes(`/${op}/`) ||
        rel.endsWith(`/${op}`)
      );
    });
  }

  private normalizePath(p: string): string {
    return path.relative(process.cwd(), p).replace(/\\/g, '/');
  }
}
