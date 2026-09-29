import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeBaseUrl, removeBaseUrl, launchdPlist, systemdUnit, setupClaudeCode, undoClaudeCode, setupService } from '../src/setup.ts';

describe('settings merge', () => {
  test('adds the env block without touching other keys', () => {
    const r = mergeBaseUrl({ hooks: { a: 1 }, env: { FOO: 'bar' } }, 'http://localhost:8788');
    expect(r.changed).toBe(true);
    expect(r.settings).toEqual({ hooks: { a: 1 }, env: { FOO: 'bar', ANTHROPIC_BASE_URL: 'http://localhost:8788' } });
  });
  test('refuses to replace a foreign base url unless forced', () => {
    const r = mergeBaseUrl({ env: { ANTHROPIC_BASE_URL: 'https://proxy.corp' } }, 'http://localhost:8788');
    expect(r.changed).toBe(false);
    expect(r.reason).toContain('--force');
    expect(mergeBaseUrl({ env: { ANTHROPIC_BASE_URL: 'https://proxy.corp' } }, 'http://localhost:8788', true).changed).toBe(true);
  });
  test('replaces its own url on another port and is idempotent', () => {
    expect(mergeBaseUrl({ env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' } }, 'http://localhost:8788').changed).toBe(true);
    expect(mergeBaseUrl({ env: { ANTHROPIC_BASE_URL: 'http://localhost:8788' } }, 'http://localhost:8788').changed).toBe(false);
  });
  test('undo removes only its own url and drops an empty env', () => {
    expect(removeBaseUrl({ env: { ANTHROPIC_BASE_URL: 'http://localhost:8788' }, x: 1 }).settings).toEqual({ x: 1 });
    expect(removeBaseUrl({ env: { ANTHROPIC_BASE_URL: 'https://proxy.corp' } }).changed).toBe(false);
  });
});

describe('service files', () => {
  test('launchd plist carries the command and log path', () => {
    const p = launchdPlist(['/usr/local/bin/promptreduce', 'proxy'], '/home/x/.promptreduce/proxy.log');
    expect(p).toContain('<string>dev.promptreduce.proxy</string>');
    expect(p).toContain('<string>/usr/local/bin/promptreduce</string>\n    <string>proxy</string>');
    expect(p).toContain('<key>KeepAlive</key><true/>');
  });
  test('systemd unit quotes paths with spaces', () => {
    expect(systemdUnit(['/opt/my tools/promptreduce', 'proxy'])).toContain('ExecStart="/opt/my tools/promptreduce" proxy');
  });
});

describe('setup on disk', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-home-'));
  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  test('writes settings with a backup, then undoes', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    expect(setupClaudeCode({ home, log })).toBe(true);
    const written = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://localhost:8788');
    expect(written.hooks).toEqual({});
    expect(readdirSync(join(home, '.claude')).some((f) => f.startsWith('settings.json.bak-'))).toBe(true);
    expect(undoClaudeCode({ home, log })).toBe(true);
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))).toEqual({ hooks: {} });
  });
  test('dry run writes nothing', () => {
    const h2 = mkdtempSync(join(tmpdir(), 'pr-home-'));
    expect(setupClaudeCode({ home: h2, log, dryRun: true })).toBe(true);
    expect(existsSync(join(h2, '.claude', 'settings.json'))).toBe(false);
    expect(setupService({ home: h2, log, dryRun: true, platform: 'darwin', command: ['/x/promptreduce', 'proxy'] })).toBe(true);
    expect(existsSync(join(h2, 'Library', 'LaunchAgents'))).toBe(false);
    expect(logs.some((l) => l.includes('launchctl bootstrap'))).toBe(true);
  });
  test('refuses invalid settings json', () => {
    const h3 = mkdtempSync(join(tmpdir(), 'pr-home-'));
    mkdirSync(join(h3, '.claude'));
    writeFileSync(join(h3, '.claude', 'settings.json'), '{broken');
    expect(setupClaudeCode({ home: h3, log })).toBe(false);
    expect(readFileSync(join(h3, '.claude', 'settings.json'), 'utf8')).toBe('{broken');
  });
});
