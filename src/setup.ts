/**
 * `promptreduce setup`: point Claude Code at the proxy and keep the proxy
 * running at login. Every change is printed, settings are backed up first,
 * and --undo reverts exactly what setup wrote.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

export interface SetupOptions {
  home?: string;
  cwd?: string;
  port?: number;
  project?: boolean;
  dryRun?: boolean;
  force?: boolean;
  /** How to start the proxy: the compiled binary alone, or bun + cli.ts when running from source. */
  command?: string[];
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
}

const LABEL = 'dev.promptreduce.proxy';
const isOurs = (url: unknown, port: number) => typeof url === 'string' && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(url) && (url.includes(`:${port}`) || true);

/** Pure: returns the settings object with the base URL set, or an explanation of why not. */
export function mergeBaseUrl(settings: Record<string, unknown>, url: string, force = false): { settings: Record<string, unknown>; changed: boolean; reason?: string } {
  const env = (settings.env && typeof settings.env === 'object' ? { ...(settings.env as Record<string, unknown>) } : {});
  const current = env.ANTHROPIC_BASE_URL;
  if (current === url) return { settings, changed: false, reason: 'already set' };
  if (current !== undefined && !isOurs(current, 0) && !force) return { settings, changed: false, reason: `ANTHROPIC_BASE_URL is already ${String(current)}; pass --force to replace it` };
  env.ANTHROPIC_BASE_URL = url;
  return { settings: { ...settings, env }, changed: true };
}

export function removeBaseUrl(settings: Record<string, unknown>): { settings: Record<string, unknown>; changed: boolean } {
  const env = settings.env && typeof settings.env === 'object' ? { ...(settings.env as Record<string, unknown>) } : null;
  if (!env || !isOurs(env.ANTHROPIC_BASE_URL, 0)) return { settings, changed: false };
  delete env.ANTHROPIC_BASE_URL;
  const next = { ...settings } as Record<string, unknown>;
  if (Object.keys(env).length) next.env = env; else delete next.env;
  return { settings: next, changed: true };
}

export function launchdPlist(command: string[], logFile: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((c) => `    <string>${esc(c)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(command: string[]): string {
  const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return `[Unit]
Description=promptreduce proxy for the Anthropic API
After=network.target

[Service]
ExecStart=${command.map(q).join(' ')}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function defaultCommand(): string[] {
  const entry = process.argv[1] ?? '';
  // Running from source: bun src/cli.ts. A compiled binary reports a virtual entry path that does not exist on disk.
  if (/cli\.ts$/.test(entry) && existsSync(entry)) return [process.execPath, entry, 'proxy'];
  return [process.execPath, 'proxy'];
}

function settingsPath(o: Required<Pick<SetupOptions, 'home' | 'cwd' | 'project'>>) {
  return o.project ? join(o.cwd, '.claude', 'settings.json') : join(o.home, '.claude', 'settings.json');
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return {};
  try { const j = JSON.parse(readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

function run(cmd: string[], log: (s: string) => void, dryRun: boolean): boolean {
  log(`  $ ${cmd.join(' ')}`);
  if (dryRun) return true;
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) { log(`    failed (${r.exitCode}): ${new TextDecoder().decode(r.stderr).trim().slice(0, 300)}`); return false; }
  return true;
}

export function setupClaudeCode(opts: SetupOptions = {}): boolean {
  const o = { home: opts.home ?? homedir(), cwd: opts.cwd ?? process.cwd(), project: opts.project ?? false, port: opts.port ?? 8788, dryRun: opts.dryRun ?? false, force: opts.force ?? false, log: opts.log ?? console.log };
  const file = settingsPath(o);
  const url = `http://localhost:${o.port}`;
  const current = readJson(file);
  if (current === null) { o.log(`Claude Code: ${file} is not valid JSON; not touching it`); return false; }
  const m = mergeBaseUrl(current, url, o.force);
  if (!m.changed) { o.log(`Claude Code: ${file}: ${m.reason}`); return m.reason === 'already set'; }
  o.log(`Claude Code: set env.ANTHROPIC_BASE_URL = ${url} in ${file}${existsSync(file) ? ' (backup kept beside it)' : ' (new file)'}`);
  if (o.dryRun) return true;
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  writeFileSync(file, JSON.stringify(m.settings, null, 2) + '\n');
  return true;
}

export function undoClaudeCode(opts: SetupOptions = {}): boolean {
  const o = { home: opts.home ?? homedir(), cwd: opts.cwd ?? process.cwd(), project: opts.project ?? false, dryRun: opts.dryRun ?? false, log: opts.log ?? console.log };
  const file = settingsPath(o);
  const current = readJson(file);
  if (!current) { o.log(`Claude Code: nothing to undo in ${file}`); return true; }
  const r = removeBaseUrl(current);
  if (!r.changed) { o.log(`Claude Code: ${file} has no promptreduce base URL`); return true; }
  o.log(`Claude Code: remove env.ANTHROPIC_BASE_URL from ${file}`);
  if (!o.dryRun) writeFileSync(file, JSON.stringify(r.settings, null, 2) + '\n');
  return true;
}

export function setupService(opts: SetupOptions = {}): boolean {
  const o = { home: opts.home ?? homedir(), dryRun: opts.dryRun ?? false, log: opts.log ?? console.log, command: opts.command ?? defaultCommand(), platform: opts.platform ?? platform() };
  const logFile = join(o.home, '.promptreduce', 'proxy.log');
  if (o.platform === 'darwin') {
    const plist = join(o.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    o.log(`Service: write ${plist} and load it (starts at login, restarts if it stops; log at ${logFile})`);
    o.log(`  command: ${o.command.join(' ')}`);
    if (!o.dryRun) { mkdirSync(dirname(plist), { recursive: true }); mkdirSync(dirname(logFile), { recursive: true }); writeFileSync(plist, launchdPlist(o.command, logFile)); }
    const uid = process.getuid?.() ?? 501;
    run(['launchctl', 'bootout', `gui/${uid}/${LABEL}`], () => {}, o.dryRun);
    return run(['launchctl', 'bootstrap', `gui/${uid}`, plist], o.log, o.dryRun) || run(['launchctl', 'load', '-w', plist], o.log, o.dryRun);
  }
  if (o.platform === 'linux') {
    const unit = join(o.home, '.config', 'systemd', 'user', 'promptreduce.service');
    o.log(`Service: write ${unit} and enable it (systemd user unit)`);
    o.log(`  command: ${o.command.join(' ')}`);
    if (!o.dryRun) { mkdirSync(dirname(unit), { recursive: true }); writeFileSync(unit, systemdUnit(o.command)); }
    return run(['systemctl', '--user', 'daemon-reload'], o.log, o.dryRun) && run(['systemctl', '--user', 'enable', '--now', 'promptreduce'], o.log, o.dryRun);
  }
  if (o.platform === 'win32') {
    const tr = o.command.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(' ');
    o.log('Service: register a Task Scheduler task that starts the proxy at logon');
    o.log(`  command: ${tr}`);
    return run(['schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/TN', 'promptreduce', '/TR', tr], o.log, o.dryRun) && run(['schtasks', '/Run', '/TN', 'promptreduce'], o.log, o.dryRun);
  }
  o.log(`Service: no service integration for ${o.platform}; run \`promptreduce proxy\` yourself`);
  return false;
}

export function undoService(opts: SetupOptions = {}): boolean {
  const o = { home: opts.home ?? homedir(), dryRun: opts.dryRun ?? false, log: opts.log ?? console.log, platform: opts.platform ?? platform() };
  if (o.platform === 'darwin') {
    const plist = join(o.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const uid = process.getuid?.() ?? 501;
    run(['launchctl', 'bootout', `gui/${uid}/${LABEL}`], o.log, o.dryRun);
    if (existsSync(plist)) { o.log(`Service: remove ${plist}`); if (!o.dryRun) unlinkSync(plist); }
    return true;
  }
  if (o.platform === 'linux') {
    run(['systemctl', '--user', 'disable', '--now', 'promptreduce'], o.log, o.dryRun);
    const unit = join(o.home, '.config', 'systemd', 'user', 'promptreduce.service');
    if (existsSync(unit)) { o.log(`Service: remove ${unit}`); if (!o.dryRun) unlinkSync(unit); }
    return true;
  }
  if (o.platform === 'win32') return run(['schtasks', '/Delete', '/F', '/TN', 'promptreduce'], o.log, o.dryRun);
  return true;
}

export function runSetup(args: string[]): number {
  const has = (f: string) => args.includes(f);
  const port = Number(args[args.indexOf('--port') + 1] || '') || 8788;
  const common: SetupOptions = { dryRun: has('--dry-run'), project: has('--project'), force: has('--force'), port };
  const wantClaude = has('--claude-code') || has('--all');
  const wantService = has('--service') || has('--all');
  if (has('--undo')) {
    const a = wantClaude || !wantService ? undoClaudeCode(common) : true;
    const b = wantService || !wantClaude ? undoService(common) : true;
    return a && b ? 0 : 1;
  }
  if (!wantClaude && !wantService) {
    console.log(`promptreduce setup <what> [--dry-run] [--undo]

  --claude-code   write ANTHROPIC_BASE_URL=http://localhost:${port} into Claude Code's settings
                  (~/.claude/settings.json, or ./.claude/settings.json with --project)
  --service       start the proxy at login and keep it running (launchd, systemd user unit, or Task Scheduler)
  --all           both
  --dry-run       print the changes without making them
  --undo          revert what setup wrote (combine with --claude-code, --service or nothing for both)
  --port N        proxy port (default 8788)   --force   replace a foreign ANTHROPIC_BASE_URL`);
    return 0;
  }
  if (common.dryRun) console.log('dry run: nothing will be written');
  let ok = true;
  if (wantClaude) ok = setupClaudeCode(common) && ok;
  if (wantService) ok = setupService(common) && ok;
  if (ok) console.log(`\nDone. Check http://localhost:${port}/__promptreduce/health, then run \`promptreduce analyze\` any time to see the effect.`);
  return ok ? 0 : 1;
}
