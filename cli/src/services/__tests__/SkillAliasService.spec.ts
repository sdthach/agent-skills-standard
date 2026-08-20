import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillAliasService } from '../SkillAliasService';

describe('SkillAliasService', () => {
  let base: string;
  let root: string;
  const service = new SkillAliasService();

  const addSkill = async (rel: string) =>
    fs.outputFile(path.join(base, rel, 'SKILL.md'), '---\nname: x\n---\n');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'alias-'));
    base = path.join(root, '.claude/skills');
    await fs.ensureDir(base);
  });

  afterEach(async () => {
    await fs.remove(root);
  });

  it('exposes nested skills one level up so native discovery finds them', async () => {
    await addSkill('common/common-tdd');
    await addSkill('typescript/typescript-security');

    const created = await service.syncAliases(base);

    expect(created).toEqual(['common-tdd', 'typescript-security']);
    for (const name of created) {
      expect(await fs.pathExists(path.join(base, name, 'SKILL.md'))).toBe(true);
    }
  });

  it('leaves the category tree in place so the router still resolves', async () => {
    await addSkill('common/common-tdd');
    await fs.outputFile(path.join(base, 'common/_INDEX.md'), 'idx');

    await service.syncAliases(base);

    expect(await fs.pathExists(path.join(base, 'common/common-tdd/SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(base, 'common/_INDEX.md'))).toBe(true);
  });

  it('collapses a category whose only skill shares its name', async () => {
    await addSkill('qrspi/qrspi');
    await fs.outputFile(path.join(base, 'qrspi/_INDEX.md'), 'idx');

    await service.syncAliases(base);

    // The alias name collides with the category dir, so the skill moves up.
    expect(await fs.pathExists(path.join(base, 'qrspi/SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(base, 'qrspi/_INDEX.md'))).toBe(true);
    expect(await fs.pathExists(path.join(base, 'qrspi/qrspi'))).toBe(false);
  });

  it('does not collapse a category that has other skills', async () => {
    await addSkill('common/common');
    await addSkill('common/common-tdd');

    await service.syncAliases(base);

    expect(await fs.pathExists(path.join(base, 'common/common/SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(base, 'common/common-tdd/SKILL.md'))).toBe(true);
  });

  it('prunes aliases whose target no longer exists', async () => {
    await addSkill('common/common-tdd');
    await fs.symlink('common/removed-skill', path.join(base, 'removed-skill'), 'dir');

    await service.syncAliases(base);

    expect(await fs.pathExists(path.join(base, 'removed-skill'))).toBe(false);
    expect(await fs.pathExists(path.join(base, 'common-tdd/SKILL.md'))).toBe(true);
  });

  it('is idempotent', async () => {
    await addSkill('common/common-tdd');

    const first = await service.syncAliases(base);
    const second = await service.syncAliases(base);

    expect(second).toEqual(first);
    expect(await fs.pathExists(path.join(base, 'common-tdd/SKILL.md'))).toBe(true);
  });

  it('refuses to clobber a real directory occupying an alias name', async () => {
    await addSkill('common/common-tdd');
    await fs.outputFile(path.join(base, 'common-tdd/mine.md'), 'user content');

    await service.syncAliases(base);

    expect((await fs.lstat(path.join(base, 'common-tdd'))).isSymbolicLink()).toBe(false);
    expect(await fs.pathExists(path.join(base, 'common-tdd/mine.md'))).toBe(true);
  });

  it('returns nothing when the skills dir is absent', async () => {
    expect(await service.syncAliases(path.join(root, 'nope'))).toEqual([]);
  });
});
