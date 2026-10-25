#!/usr/bin/env node

// ELECTRON_RUN_AS_NODE 场景（安装器用宿主自身当 Node）：关闭 Electron 的
// asar fs 劫持，否则 @electron/asar 读 "xxx.asar\内路径" 时会被内置 asar 层拦截。
// 纯 Node 下该属性无副作用。
process.noAsar = true;

import { doctor } from '../src/commands/doctor.js';
import { pluginCommand } from '../src/commands/plugin.js';
import { install } from '../src/commands/install.js';
import { restore } from '../src/commands/restore.js';

const args = process.argv.slice(2);
const command = args[0] || 'help';

// Shared flags: --path <dir> (host directory), --force (kill running client)
function readFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--path') flags.path = rest[++i];
    else if (rest[i] === '--force') flags.force = true;
  }
  return flags;
}

const HELP = `
ZMod CLI v2.0.0 — Next-generation modular mod loader for ZCode

使用方法:
  zmod <command> [options]

常用命令:
  zmod doctor               诊断宿主、补丁标记、熔断哨兵、运行时与插件
  zmod install              将 ZMod 微内核安装到 ZCode 客户端（外置运行时 + asar 四通道补丁）
      [--path <dir>]          指定 ZCode 安装目录（默认自动探测）
      [--force]               客户端运行中时自动结束进程并在完成后重启
  zmod restore              还原官方纯净客户端
  zmod plugin list          查看已安装插件
  zmod plugin install <src> 安装插件（本地目录 / .zip / git 仓库 URL）
  zmod plugin enable <id>   启用插件（重启客户端生效）
  zmod plugin disable <id>  禁用插件
`;

async function main() {
  const flags = readFlags(args.slice(1));
  switch (command) {
    case 'doctor':
      await doctor(flags);
      break;
    case 'plugin':
      await pluginCommand(args[1], args[2]);
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
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.log(HELP);
      console.error(`\n未知命令: ${command}`);
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
