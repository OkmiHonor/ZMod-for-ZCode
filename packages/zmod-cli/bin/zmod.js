#!/usr/bin/env node

// ELECTRON_RUN_AS_NODE 场景（安装器用宿主自身当 Node）：关闭 Electron 的
// asar fs 劫持，否则 @electron/asar 读 "xxx.asar\内路径" 时会被内置 asar 层拦截。
// 纯 Node 下该属性无副作用。
process.noAsar = true;

import { doctor } from '../src/commands/doctor.js';
import { pluginCommand } from '../src/commands/plugin.js';
import { install } from '../src/commands/install.js';
import { restore } from '../src/commands/restore.js';
import { uninstall } from '../src/commands/uninstall.js';
import { createRequire } from 'node:module';

const { version: CLI_VERSION } = createRequire(import.meta.url)('../package.json');

const args = process.argv.slice(2);
const command = args[0] || 'help';

// Shared flags: --path <dir> (host directory), --force (kill running client)
function readFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--path') flags.path = rest[++i];
    else if (rest[i] === '--force') flags.force = true;
    else if (rest[i] === '--baseline') flags.baseline = rest[++i];
    else if (rest[i] === '--wipe-data') flags.wipeData = true;
  }
  return flags;
}

const HELP = `
ZMod CLI v${CLI_VERSION} — Next-generation modular mod loader for ZCode

Usage:
  zmod <command> [options]

Common commands:
  zmod doctor               Diagnose host, patch markers, fuse sentinel, runtime and plugins
  zmod install              Install the ZMod microkernel into the ZCode client (external runtime + 4-channel asar patches)
      [--path <dir>]          ZCode install directory (auto-detected by default)
      [--force]               When the client is running, kill the process automatically and relaunch when done
      [--baseline <file>]     install only: path to the pristine official app.asar (recovery channel when the baseline is lost)
  zmod restore              Restore the pristine official client
  zmod plugin list          List installed plugins
  zmod plugin install <src> Install a plugin (local dir / .zip / git repo URL)
  zmod plugin remove <id>   Uninstall a plugin (config kept, reinstall restores it)
  zmod plugin update [id]   Update plugins (no id = all ledger entries; zip/dir sources do not support auto-update)
  zmod plugin search [term] Search the official plugin registry (id / name / description)
  zmod plugin enable <id>   Enable a plugin (takes effect after client restart)
  zmod plugin disable <id>  Disable a plugin
  zmod plugin init <id>     Generate a plugin scaffold (manifest + index.js + README + tests) [--dir <dir>]
`;

async function main() {
  // --help/-h anywhere after the command = dry path: never execute side effects
  if (command !== 'help' && (args.includes('--help') || args.includes('-h'))) {
    console.log(HELP);
    return;
  }
  const flags = readFlags(args.slice(1));
  switch (command) {
    case 'doctor':
      await doctor(flags);
      break;
    case 'plugin':
      await pluginCommand(args[1], args[2], args.slice(3));
      break;
    case 'plugin-install':
      await pluginCommand('install', args[1]);
      break;
    case 'install':
      await install(flags);
      break;
    case 'restore':
      await restore(flags);
      break;
    case 'uninstall':
      await uninstall(flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.log(HELP);
      console.error(`\nUnknown command: ${command}`);
      process.exitCode = 1;
  }
}

// 命令完成后强制退出：以 ELECTRON_RUN_AS_NODE（宿主当 Node）运行时，
// Electron 的后台句柄（crashpad 等）可能让进程在脚本结束后仍不退出，
// 外层 cmd / NSIS ExecWait 会一直等待，表现为"输出已完成但窗口不关"。
main().then(
  () => process.exit(process.exitCode || 0),
  (err) => {
    console.error('\n[ZMod CLI Error]:', err?.stack || err?.message || err);
    process.exit(1);
  }
);
