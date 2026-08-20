import os from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getInstallRoot,
  getInstallScope,
  resetInstallRoot,
  setInstallScope,
} from '../InstallRoot';

describe('InstallRoot', () => {
  afterEach(() => resetInstallRoot());

  it('defaults to project scope at the current working directory', () => {
    expect(getInstallScope()).toBe('project');
    expect(getInstallRoot()).toBe(process.cwd());
  });

  it('resolves user scope to the home directory', () => {
    setInstallScope('user', '/home/someone');
    expect(getInstallScope()).toBe('user');
    expect(getInstallRoot()).toBe('/home/someone');
  });

  it('uses the real home directory by default at user scope', () => {
    setInstallScope('user');
    expect(getInstallRoot()).toBe(os.homedir());
  });

  it('returns to cwd when switched back to project scope', () => {
    setInstallScope('user', '/home/someone');
    setInstallScope('project');
    expect(getInstallRoot()).toBe(process.cwd());
  });

  it('reset restores the default', () => {
    setInstallScope('user', '/home/someone');
    resetInstallRoot();
    expect(getInstallScope()).toBe('project');
    expect(getInstallRoot()).toBe(process.cwd());
  });
});
