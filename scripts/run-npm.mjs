import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

// pnpm forwards a few of its own legacy settings as NPM_CONFIG_* variables.
// npm 11 reports them as unknown, although they do not affect this install.
const environment = { ...process.env };
for (const key of [
  'npm_config_npm_globalconfig',
  'npm_config_verify_deps_before_run',
  'npm_config__jsr_registry',
]) {
  delete environment[key];
}

// Node 20+ on Windows rejects spawning .cmd/.bat without shell (EINVAL).
// Invoke npm-cli.js through node so we never need shell:true.
function resolveNpmSpawn() {
  const args = process.argv.slice(2);
  if (process.platform !== 'win32') {
    return { command: 'npm', args };
  }

  const npmCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  if (existsSync(npmCli)) {
    return { command: process.execPath, args: [npmCli, ...args] };
  }

  // Fallback for unusual installs where npm is not next to node.exe.
  return { command: 'npm.cmd', args, shell: true };
}

const { command, args, shell = false } = resolveNpmSpawn();
const child = spawn(command, args, {
  env: environment,
  stdio: 'inherit',
  shell,
});

child.once('error', (error) => {
  console.error(`无法启动 npm：${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});