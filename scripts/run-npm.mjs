import { spawn } from 'node:child_process';

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

const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', process.argv.slice(2), {
  env: environment,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(`无法启动 npm：${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
