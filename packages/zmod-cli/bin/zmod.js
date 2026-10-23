#!/usr/bin/env node

import { doctor } from '../src/commands/doctor.js';
import { pluginCommand } from '../src/commands/plugin.js';
import { install } from '../src/commands/install.js';
import { restore } from '../src/commands/restore.js';

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
  switch (command) {
    case 'doctor':
      await doctor();
      break;
    case 'plugin':
      await pluginCommand(args[1], args[2]);
      break;
    case 'install':
      await install();
      break;
    case 'restore':
      await restore();
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(`
ZMod CLI v2.0.0 - Next-generation modular mod loader for ZCode

使用方法:
  zmod <command> [options]

常用命令:
  zmod doctor               诊断环境、客户端路径与已安装插件
  zmod install              一键将 ZMod 微内核安装到 ZCode 客户端
  zmod restore              一键还原官方纯净客户端
  zmod plugin list          查看所有可用插件及其启用状态
  zmod plugin enable <id>   启用指定插件
  zmod plugin disable <id>  禁用指定插件

更多信息请访问: https://github.com/zmod-dev/zmod
`);
      break;
  }
}

main().catch((err) => {
  console.error('\n[ZMod CLI Error]:', err.message);
  process.exit(1);
});
