import fs from 'fs-extra';
import path from 'path';
import pc from 'picocolors';

/**
 * Makes a `<category>/<skill>` skill tree discoverable by agents that only scan
 * one level below their skills directory (Claude Code).
 *
 * Emits `<base>/<skill>` -> `<base>/<category>/<skill>` as relative symlinks
 * rather than moving anything, so the category tree, the per-category
 * `_INDEX.md` router and the MCP all keep resolving against the same files.
 */
export class SkillAliasService {
  /**
   * A category directory whose only skill shares its name cannot host a sibling
   * alias of that name. Collapse it instead: move `<base>/<cat>/<cat>` up into
   * `<base>/<cat>`, leaving `_INDEX.md` alongside `SKILL.md`.
   */
  private async collapseSelfNamedCategory(
    baseDir: string,
    category: string,
  ): Promise<boolean> {
    const categoryDir = path.join(baseDir, category);
    const nested = path.join(categoryDir, category);
    if (!(await fs.pathExists(path.join(nested, 'SKILL.md')))) return false;

    const siblings = (await fs.readdir(categoryDir)).filter(
      (entry) => entry !== category && !entry.startsWith('_'),
    );
    if (siblings.length > 0) return false;

    for (const entry of await fs.readdir(nested)) {
      await fs.move(path.join(nested, entry), path.join(categoryDir, entry), {
        overwrite: true,
      });
    }
    await fs.remove(nested);
    return true;
  }

  /**
   * @returns names of the aliases now present under `baseDir`
   */
  async syncAliases(baseDir: string): Promise<string[]> {
    if (!(await fs.pathExists(baseDir))) return [];

    const entries = await fs.readdir(baseDir);
    const categories: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith('.') || entry.startsWith('_')) continue;
      const full = path.join(baseDir, entry);
      const stat = await fs.lstat(full);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      // A directory holding SKILL.md directly is already a discoverable skill.
      if (await fs.pathExists(path.join(full, 'SKILL.md'))) continue;
      categories.push(entry);
    }

    const created: string[] = [];
    const wanted = new Map<string, string>();

    for (const category of categories) {
      if (await this.collapseSelfNamedCategory(baseDir, category)) continue;

      const categoryDir = path.join(baseDir, category);
      for (const skill of await fs.readdir(categoryDir)) {
        if (skill.startsWith('.') || skill.startsWith('_')) continue;
        if (!(await fs.pathExists(path.join(categoryDir, skill, 'SKILL.md')))) {
          continue;
        }
        wanted.set(skill, path.join(category, skill));
      }
    }

    // Prune aliases whose target is gone (skill excluded via .skillsrc, renamed,
    // or removed upstream) so no dangling link is left behind.
    //
    // Only ever touch links this service created: a relative target resolving to
    // `<category>/<skill>` inside baseDir. Users and other tools put their own
    // symlinks here -- notably package-manager-backed skills pointing at an
    // absolute store path -- and deleting those destroys skills we do not own.
    for (const entry of await fs.readdir(baseDir)) {
      const full = path.join(baseDir, entry);
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat?.isSymbolicLink()) continue;

      const target = await fs.readlink(full).catch(() => null);
      if (target === null || path.isAbsolute(target)) continue;

      const resolved = path.resolve(baseDir, target);
      const insideBase = resolved.startsWith(baseDir + path.sep);
      const twoSegments = target.split(/[\\/]/).filter(Boolean).length === 2;
      if (!insideBase || !twoSegments) continue;

      if (!wanted.has(entry) || !(await fs.pathExists(full))) {
        await fs.remove(full);
      }
    }

    for (const [skill, target] of wanted) {
      const aliasPath = path.join(baseDir, skill);
      const stat = await fs.lstat(aliasPath).catch(() => null);

      if (stat && !stat.isSymbolicLink()) {
        console.log(
          pc.yellow(
            `    ⚠️  Skipping alias for '${skill}': a real directory already occupies that name`,
          ),
        );
        continue;
      }
      if (stat?.isSymbolicLink()) {
        const existing = await fs.readlink(aliasPath).catch(() => null);
        if (existing === target) {
          created.push(skill);
          continue;
        }
        await fs.remove(aliasPath);
      }

      try {
        await fs.symlink(target, aliasPath, 'dir');
        created.push(skill);
      } catch {
        // Windows without developer mode rejects symlinks; a junction works and
        // a copy is the last resort so discovery still succeeds.
        try {
          await fs.symlink(target, aliasPath, 'junction');
          created.push(skill);
        } catch {
          await fs.copy(path.join(baseDir, target), aliasPath);
          created.push(skill);
        }
      }
    }

    return created.sort();
  }
}
