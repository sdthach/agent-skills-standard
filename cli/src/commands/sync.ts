import inquirer from 'inquirer';
import pc from 'picocolors';
import { Agent } from '../constants';
import {
  McpScope,
  SkillConfig,
  SkillSource,
  UpdatePolicy,
} from '../models/config';
import { ConfigService } from '../services/ConfigService';
import {
  InstallScope,
  getInstallRoot,
  getInstallScope,
  setInstallScope,
} from '../services/InstallRoot';
import { DetectionService } from '../services/DetectionService';
import {
  McpConfigService,
  defaultMcpConfig,
} from '../services/McpConfigService';
import { HookService } from '../services/HookService';
import { SyncService } from '../services/SyncService';

const UPDATE_POLICIES = ['pin', 'notify', 'always'] as const;

interface SyncOptions {
  yes?: boolean;
  snippets?: boolean;
  local?: boolean;
  update?: string;
  scope?: string;
}

function isUpdatePolicy(value: string): value is UpdatePolicy {
  return UPDATE_POLICIES.some((policy) => policy === value);
}

/**
 * Command for synchronizing skills and workflows from the remote registry to the local workspace.
 * It handles configuration re-detection, fetching files, writing to disk, and updating indices.
 */
export class SyncCommand {
  private configService: ConfigService;
  private detectionService: DetectionService;
  private syncService: SyncService;
  private mcpService: McpConfigService;
  private hookService: HookService;

  constructor(
    configService?: ConfigService,
    detectionService?: DetectionService,
    syncService?: SyncService,
    mcpService?: McpConfigService,
    hookService?: HookService,
  ) {
    this.configService = configService || new ConfigService();
    this.detectionService = detectionService || new DetectionService();
    this.syncService = syncService || new SyncService();
    this.mcpService = mcpService || new McpConfigService();
    this.hookService = hookService || new HookService();
  }

  /**
   * Executes the synchronization flow.
   * Reconciles dependencies, fetches skills and workflows from the registry, and updates AGENTS.md.
   */
  async run(options: SyncOptions = {}): Promise<void> {
    try {
      // 0. Resolve where this install writes, before anything reads a path.
      const scope: InstallScope = options.scope === 'user' ? 'user' : 'project';
      if (options.scope && options.scope !== 'user' && options.scope !== 'project') {
        console.log(
          pc.red(`❌ Error: --scope must be 'project' or 'user' (got '${options.scope}').`),
        );
        return;
      }
      setInstallScope(scope);
      if (scope === 'user') {
        console.log(
          pc.cyan(`🏠 User-scoped install -> ${getInstallRoot()}`),
        );
      }

      // 1. Load Config
      const config = await this.configService.loadConfig();
      if (!config) {
        console.log(pc.red('❌ Error: .skillsrc not found. Run `init` first.'));
        return;
      }

      const source: SkillSource = options.local
        ? 'local'
        : (config.source ?? 'github');
      const requestedUpdate = options.update ?? config.update ?? 'pin';
      if (!isUpdatePolicy(requestedUpdate)) {
        console.error(
          pc.red(
            `❌ Invalid update mode "${requestedUpdate}". Expected pin, notify, or always.`,
          ),
        );
        return;
      }
      config.source = source;
      config.update = requestedUpdate;

      if (source === 'local') {
        console.log(
          pc.cyan(
            '🔌 Local mode: building from on-disk registry (no network).',
          ),
        );
      }

      // 2. Dynamic Update Configuration (Re-detection)
      const projectDeps = await this.detectionService.getProjectDeps();
      const skillsChanged = await this.syncService.reconcileConfig(
        config,
        projectDeps,
      );
      const checksEnabled = source === 'github' && requestedUpdate !== 'pin';
      const workflowsChanged = checksEnabled
        ? await this.syncService.reconcileWorkflows(config)
        : false;

      if (skillsChanged || workflowsChanged) {
        await this.configService.saveConfig(config);
      }

      // 3. Check for updates when the selected GitHub policy permits it.
      if (checksEnabled) {
        const updates = await this.syncService.checkForUpdates(config);
        await this.applyAvailableUpdates(
          config,
          updates,
          requestedUpdate,
          options,
        );
      }

      if (source === 'github') {
        console.log(pc.cyan(`🚀 Syncing skills from ${config.registry}...`));
      }

      // 4. Assemble skills from the selected source
      const enabledCategories = Object.keys(config.skills);
      const skills = await this.syncService.assembleSkills(
        enabledCategories,
        config,
      );

      // 4b. Assemble workflows
      const workflows = await this.syncService.assembleWorkflows(config);

      // 5. Write skills and workflows to target
      await this.syncService.writeSkills(skills, config);
      await this.syncService.writeWorkflows(workflows, config);

      // 5b. Sync specialists (sub-agents)
      await this.syncService.syncSpecialists(config);

      // 6. Automatically apply framework-specific indices to AGENTS.md
      await this.syncService.applyIndices(config, config.agents);

      console.log(pc.green('✅ All skills synced successfully!'));

      // 7. MCP integration (consent-respecting — see McpConfigService).
      await this.runMcpPhase(config, options);

      // 8. Hook installation — always runs; idempotent.
      await this.runHookPhase(config);
    } catch (error) {
      if (error instanceof Error) {
        console.error(pc.red('❌ Sync failed:'), error.message);
      } else {
        console.error(pc.red('❌ Sync failed:'), String(error));
      }
    }
  }

  private async applyAvailableUpdates(
    config: SkillConfig,
    updates: Record<string, string> | null,
    policy: UpdatePolicy,
    options: SyncOptions,
  ): Promise<void> {
    if (!updates || Object.keys(updates).length === 0) return;

    console.log(pc.yellow('\n🚀 New skill versions detected:'));
    for (const [category, ref] of Object.entries(updates)) {
      console.log(
        pc.gray(`  - ${category}: ${config.skills[category].ref} -> ${ref}`),
      );
    }

    const shouldApply = await this.shouldApplyUpdates(policy, options);
    if (!shouldApply) {
      console.log(
        pc.cyan('ℹ️  Skipping version updates, staying on pinned refs.'),
      );
      return;
    }

    for (const [category, ref] of Object.entries(updates)) {
      config.skills[category].ref = ref;
    }
    await this.configService.saveConfig(config);
    console.log(pc.green('✅ .skillsrc updated.'));
  }

  private async shouldApplyUpdates(
    policy: UpdatePolicy,
    options: SyncOptions,
  ): Promise<boolean> {
    if (policy === 'always') return true;
    if (options.yes !== undefined) return options.yes;
    if (!process.stdin.isTTY) {
      console.log(
        pc.cyan(
          'ℹ️  Non-interactive environment detected. Skipping version updates. Use --yes to auto-confirm.',
        ),
      );
      return false;
    }

    const answer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'update',
        message: 'Do you want to update .skillsrc with these versions?',
        default: true,
      },
    ]);
    return answer.update;
  }

  /**
   * Phase 7 — MCP integration. Three paths:
   *   A. Never prompted yet: ask once now (with full value-prop), persist decision.
   *   B. Already prompted, mcp.enabled=true: dispatch install at the configured scope.
   *   C. Already prompted, mcp.enabled=false: skip silently.
   *
   * In non-interactive mode (no TTY) and never-prompted: skip with a hint, do
   * not assume consent. Users can opt in later via `ags mcp enable`.
   */
  private async runMcpPhase(
    config: SkillConfig,
    options: SyncOptions,
  ): Promise<void> {
    const mcp = config.mcp ? { ...config.mcp } : defaultMcpConfig();
    const agents = config.agents ?? [];

    const snippetOnlyOverride =
      options.snippets === true && (!mcp.enabled || mcp.scope === 'disabled');
    if (snippetOnlyOverride) {
      mcp.enabled = true;
      mcp.scope = 'snippets-only';
      mcp.snippets = true;
    } else if (options.snippets !== undefined) {
      mcp.snippets = options.snippets;
    }

    if (
      !snippetOnlyOverride &&
      (!mcp.prompted || (!mcp.enabled && mcp.prompted))
    ) {
      if (!process.stdin.isTTY && !options.yes) {
        if (!mcp.prompted) {
          console.log(
            pc.gray(
              '\nℹ️  MCP integration not yet configured. Run `ags mcp enable` (or `ags mcp scope project`) when ready.',
            ),
          );
        }
        return;
      }

      // If already prompted but disabled, we ask again if they want to enable it now.
      // This ensures they aren't "stuck" in a disabled state just because they said no once.
      // Pass true for wasDisabled only if it was already prompted AND it is currently disabled.
      const decided = await this.promptMcpConsent(
        options,
        mcp.prompted && !mcp.enabled,
      );
      config.mcp = {
        enabled: decided.enabled,
        scope: decided.enabled ? decided.scope : 'disabled',
        prompted: true,
      };
      await this.configService.saveConfig(config);
    }

    const finalMcp = config.mcp ? { ...config.mcp } : defaultMcpConfig();
    if (snippetOnlyOverride) {
      finalMcp.enabled = true;
      finalMcp.scope = 'snippets-only';
      finalMcp.snippets = true;
    } else if (options.snippets !== undefined) {
      finalMcp.snippets = options.snippets;
    }

    if (!finalMcp.enabled || finalMcp.scope === 'disabled') {
      return;
    }

    const userScopePrompt = options.yes
      ? async () => true
      : async (agent: Agent, file: string): Promise<boolean> => {
          const { ok } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'ok',
              message: `Write user-scope MCP config for ${pc.cyan(agent)} at ${pc.gray(file)}?`,
              default: false,
            },
          ]);
          return ok;
        };

    console.log(pc.cyan('\n🔌 Wiring MCP server...'));
    const report = await this.mcpService.install({
      rootDir: getInstallRoot(),
      agents,
      mcp: finalMcp,
      userScopePrompt,
    });

    for (const w of report.projectWrites) {
      const tag =
        w.action === 'added'
          ? pc.green('  + added   ')
          : w.action === 'updated'
            ? pc.cyan('  ~ updated ')
            : pc.gray('  = up-to-date');
      console.log(`${tag} ${w.agent.padEnd(12)} ${pc.gray(w.file)}`);
    }
    for (const w of report.userWrites) {
      console.log(
        `  ${pc.green('+ wrote   ')} ${w.agent.padEnd(12)} ${pc.gray(w.file)}`,
      );
    }
    for (const d of report.declined) {
      console.log(
        `  ${pc.gray('-         ')} ${d.agent.padEnd(12)} ${pc.gray(d.file)} (declined)`,
      );
    }
    if (report.snippets.length > 0) {
      console.log(
        pc.gray(
          `  ${report.snippets.length} snippet(s) written to ./mcp-config-snippets/`,
        ),
      );
    }
    if (report.unsupported.length > 0) {
      console.log(
        pc.gray(
          `  (skipped — no MCP support yet: ${report.unsupported.join(', ')})`,
        ),
      );
    }
  }

  private async promptMcpConsent(
    options: {
      yes?: boolean;
    },
    wasDisabled = false,
  ): Promise<{ enabled: boolean; scope: McpScope }> {
    if (options.yes) {
      // Conservative default for --yes: opt in at project scope (the recommended choice).
      return { enabled: true, scope: 'project' };
    }
    console.log(pc.bold('\n🔌 MCP server setup\n'));
    if (wasDisabled) {
      console.log(
        pc.yellow(
          'MCP integration is currently disabled. Would you like to enable it now?',
        ),
      );
    }
    console.log(
      'agent-skills-standard ships an optional MCP server that serves your skills',
    );
    console.log('to AI agents at runtime. Quick comparison:\n');
    console.log(
      pc.bold('  WITHOUT MCP:') +
        ' sub-agents skip skill loading; no audit trail',
    );
    console.log(
      pc.bold('  WITH MCP:   ') +
        ' every sub-agent can call load_skills_for_files; auditable\n',
    );

    const decision = await inquirer.prompt<{
      enabled: boolean;
      scope: McpScope;
    }>([
      {
        type: 'confirm',
        name: 'enabled',
        message: 'Enable MCP server integration?',
        default: true,
      },
      {
        type: 'list',
        name: 'scope',
        message: 'Where should sync write MCP configs?',
        when: (a) => a.enabled === true,
        choices: [
          {
            name: 'project (recommended)  — only files inside this project',
            value: 'project',
          },
          {
            name: 'user                    — also $HOME files (sync prompts each)',
            value: 'user',
          },
          {
            name: 'snippets-only           — never edits any runtime config',
            value: 'snippets-only',
          },
        ],
        default: 'project',
      },
    ]);
    return decision;
  }

  /**
   * Phase 8 — Hook installation.
   * Idempotent: registers the Claude PreToolUse entry and keeps managed hook
   * files up to date. Claude's script is preserved if already customized; Kiro's
   * markdown hook is kept in sync with the embedded template.
   */
  private async runHookPhase(config: SkillConfig): Promise<void> {
    const agents = config.agents ?? [];
    if (agents.length === 0) return;

    const mcp = config.mcp ?? defaultMcpConfig();
    if (!mcp.enabled || mcp.scope === 'disabled') {
      await this.hookService.uninstall({ rootDir: getInstallRoot(), agents });
      return;
    }

    const report = await this.hookService.install({
      rootDir: getInstallRoot(),
      agents,
      scope: getInstallScope(),
    });

    const writes = report.writes.filter((w) => w.action !== 'skipped-existing');
    if (writes.length === 0) return;

    console.log(pc.cyan('\n🪝 Updating skill-loader hooks...'));
    for (const w of writes) {
      const tag =
        w.action === 'added' ? pc.green('+ added   ') : pc.cyan('~ updated ');
      console.log(`  ${tag} ${w.agent.padEnd(12)} ${pc.gray(w.file)}`);
    }
  }
}
