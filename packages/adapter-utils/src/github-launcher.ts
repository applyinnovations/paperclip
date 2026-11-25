import { isAbsolute } from "node:path";

/** Standalone source for local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(options: { brokerFile?: boolean; interpreterPath?: string } = {}): string {
  if (options.interpreterPath !== undefined && (typeof options.interpreterPath !== "string"
    || !isAbsolute(options.interpreterPath) || /[\s\0]/u.test(options.interpreterPath))) {
    throw new Error("GitHub launcher interpreter must be an absolute path without whitespace");
  }
  return String.raw`#!${options.interpreterPath ?? "/usr/bin/env node"}
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
// A PATH shim can capture this launcher's absolute path and call it again.
// Reject that cycle before resolving another executable or capturing authority.
if (process.env.PAPERCLIP_GITHUB_OPERATION_ACTIVE) {
  process.stderr.write('Paperclip: GitHub launcher_recursion_rejected.\n');
  process.exit(126);
}
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const executable = originalPath.map(p => path.join(p, program)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
const localGitCommands = new Set(['init', 'status', 'add', 'config', 'rev-parse', 'log', 'diff', 'diff-files', 'write-tree', 'show', 'branch', 'checkout', 'switch', 'restore', 'reset', 'rm', 'mv', 'worktree', 'grep', 'blame', 'describe', 'ls-files', 'ls-tree', 'cat-file', 'rev-list', 'merge-base', 'show-ref', 'for-each-ref', 'symbolic-ref', 'check-ignore', 'version', 'help']);
const gitValueOptions = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source'];
const gitFlagOptions = ['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'];
function gitSubcommand(args) {
  if (program !== 'git') return null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (gitValueOptions.includes(arg)) { index += 1; continue; }
    if (gitValueOptions.some(option => arg.startsWith(option + '='))) continue;
    if (gitFlagOptions.includes(arg)) continue;
    return { name: arg, rest: args.slice(index + 1) };
  }
  return null;
}
function isLocalGit(args) {
  const command = gitSubcommand(args);
  return !!command && (command.name === '--version' || command.name === '--help' || localGitCommands.has(command.name));
}
// Push provenance: the ref updates a push actually sent, read from git's own packet trace
// (full SHAs and the remote's per-ref ok/ng report), and the remote from its trace2 events.
function githubRepository(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const match = /^\/+([^/]+)\/([^/]+?)(?:\.git)?\/*$/.exec(parsed.pathname);
    return match ? (match[1] + '/' + match[2]).toLowerCase() : null;
  } catch { return null; }
}
function pushReport(packetTrace, trace2) {
  let repository = null;
  for (const line of trace2.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event && event.event === 'child_start' && /^remote-https?$/.test(event.child_class) && Array.isArray(event.argv) && event.argv.length) {
      repository = githubRepository(String(event.argv[event.argv.length - 1]));
    }
  }
  const sent = new Map(), results = new Map();
  for (const line of packetTrace.split('\n')) {
    const packet = /packet:\s+([\w-]+)([<>]) (.*)$/.exec(line);
    if (!packet || packet[1] === 'receive-pack') continue;
    if (packet[2] === '>') {
      const command = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[^\s\\]+)/.exec(packet[3]);
      if (command && command[1] !== command[2]) sent.set(command[3], { ref: command[3], before: command[1], after: command[2] });
    } else {
      const status = /^(ok|ng) (refs\/[^\s\\]+)/.exec(packet[3]);
      if (status) results.set(status[2], status[1]);
    }
  }
  const updates = [...sent.values()].map(update => ({ ...update, result: results.get(update.ref) || 'unknown' }));
  return repository && updates.length ? { repository, updates } : null;
}
function forceRequested(args) {
  return args.some(arg => arg === '-f' || arg === '--force' || arg === '--mirror' || arg.startsWith('--force-with-lease') ||
    (!arg.startsWith('-') && arg.startsWith('+')) || (/^-[a-zA-Z]+$/.test(arg) && arg.includes('f')));
}
// With a Paperclip GitHub connection, repositories are created and forked
// through its tools so access rules, approvals, owner defaults and audit apply.
const connectorRepositoryTools = new Map([['create', 'create_repository'], ['new', 'create_repository'], ['fork', 'fork_repository']]);
function connectorRepositoryTool(args) {
  if (program !== 'gh' || args[0] !== 'repo' || args.includes('--help') || args.includes('-h')) return null;
  return connectorRepositoryTools.get(args[1]) || null;
}
async function main() {
  let env = { ...process.env };
${options.brokerFile ? String.raw`
  delete env.PAPERCLIP_API_URL;
  delete env.PAPERCLIP_API_KEY;
  delete env.PAPERCLIP_GITHUB_BRIDGE_TOKEN;
  env.PAPERCLIP_GITHUB_BROKER_URL = '';
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = '';
  try {
    const broker = JSON.parse(fs.readFileSync(path.join(directory, 'broker.json'), 'utf8'));
    if (typeof broker.url === 'string' && typeof broker.token === 'string') {
      env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
      env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
    }
  } catch {}
` : ''}
  const diagnostic = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; continuing without managed credentials.\n');
  let connected = false;
  let bases = [], brokerHeaders = null;
  const configRoot = env.GH_CONFIG_DIR || os.tmpdir();
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  let authorReady = false;
  try {
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
    fs.chmodSync(configDirectory, 0o700);
    configReady = true;
    process.once('exit', () => { try { fs.rmSync(configDirectory, { recursive: true, force: true }); } catch {} });
    fs.writeFileSync(path.join(configDirectory, 'gitconfig'), '[user]\n\tname = Paperclip\n\temail = noreply@paperclip.ing\n', { mode: 0o600 });
    authorReady = true;
  } catch { diagnostic('configuration_directory_unavailable'); }
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: authorReady ? path.join(configDirectory, 'gitconfig') : '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'user.useConfigOnly', GIT_CONFIG_VALUE_4: 'true',
    });
    // The broker URL is the control plane's direct address. A target that
    // can't reach it (one outside the control plane's network) still reaches
    // the run's API URL, which on a remote target is the callback bridge, and
    // the bridge forwards this route. So a broker that can't be reached at all
    // falls back to the API URL.
    bases = [...new Set([env.PAPERCLIP_GITHUB_BROKER_URL, env.PAPERCLIP_API_URL].filter(Boolean))];
    brokerHeaders = { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
      'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' };
    const askBroker = !isLocalGit(process.argv.slice(2));
    try {
    let response;
    if (askBroker && bases.length && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      // A slow or restarting control plane must not cost the operation its
      // managed identity, so a failed request is retried before giving up.
      // Busy (409) responses and transport failures keep separate budgets, and
      // the body is read inside the retry so a failed read is retried too.
      // A base with a fallback after it gets one transport attempt.
      let transportFailures = 0, conflicts = 0, result, baseIndex = 0;
      for (;;) {
        const url = bases[baseIndex].replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/credentials';
        try {
          response = await fetch(url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: brokerHeaders,
            body: '{}',
          });
          if (response.status === 409 && conflicts < 29) {
            conflicts += 1;
            await response.arrayBuffer();
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          result = response.ok ? await response.json() : null;
          break;
        } catch (error) {
          if (baseIndex < bases.length - 1) { baseIndex += 1; continue; }
          transportFailures += 1;
          if (transportFailures >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * transportFailures));
        }
      }
      if (!response.ok) {
        diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
      } else {
      if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      connected = result.status === 'available';
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else if (askBroker) { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  const connectorTool = connected ? connectorRepositoryTool(process.argv.slice(2)) : null;
  if (connectorTool) {
    process.stderr.write("Paperclip: use the GitHub connection's " + connectorTool + " tool instead of gh repo " + process.argv[3] +
      ", so the connection's access rules apply. " + (connectorTool === 'fork_repository'
        ? 'Then clone the fork or add it as a git remote.' : 'Then add the repository as a git remote and push.') + '\n');
    process.exitCode = 1;
    return;
  }
  // Only this invocation and its children inherit the captured credential.
  env.PAPERCLIP_GITHUB_OPERATION_ACTIVE = '1';
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  // A managed push reports the ref updates it sent, so the server can attribute them to this
  // run once GitHub's own push evidence arrives. It never changes the push's exit status.
  const push = gitSubcommand(process.argv.slice(2));
  const tracePush = !!push && push.name === 'push' && configReady && bases.length > 0 &&
    !!env.PAPERCLIP_GITHUB_BROKER_TOKEN && !env.GIT_TRACE_PACKET && !env.GIT_TRACE2_EVENT;
  const packetTracePath = path.join(configDirectory, 'push-packets.trace');
  const trace2Path = path.join(configDirectory, 'push-events.trace');
  if (tracePush) { env.GIT_TRACE_PACKET = packetTracePath; env.GIT_TRACE2_EVENT = trace2Path; }
  const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  const exitCode = await new Promise(resolve => {
    child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); resolve(1); });
    child.once('exit', (code) => resolve(code === null ? 128 : code));
  });
  process.exitCode = exitCode;
  if (!tracePush) return;
  let report = null;
  try {
    report = pushReport(fs.readFileSync(packetTracePath, 'utf8'), fs.readFileSync(trace2Path, 'utf8'));
  } catch {}
  try { fs.rmSync(packetTracePath, { force: true }); fs.rmSync(trace2Path, { force: true }); } catch {}
  if (!report) return;
  const forced = forceRequested(push.rest);
  for (let start = 0; start < report.updates.length; start += 100) {
    const body = JSON.stringify({ repository: report.repository, exitCode, forced, updates: report.updates.slice(start, start + 100) });
    let recorded = false, status = 'transport_unavailable';
    for (let attempt = 0; attempt < 2 * bases.length && !recorded; attempt++) {
      const url = bases[attempt % bases.length].replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/push-attempts';
      try {
        const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: brokerHeaders, body });
        await response.arrayBuffer().catch(() => undefined);
        if (response.ok) recorded = true;
        else { status = 'rejected_' + response.status; if (response.status < 500) break; }
      } catch {}
    }
    if (!recorded) {
      process.stderr.write('Paperclip: GitHub push provenance not recorded (' + status + '); approval attribution for this push will stay pending.\n');
      return;
    }
  }
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
