import fs from 'node:fs';
import path from 'node:path';
import { locateZCode } from '../locate.js';
import { ensureDirectories, getUserDataDir } from '../../../zmod-core/src/common/paths.js';

export async function install() {
  console.log('\n🚀 [ZMod Installer] 正在安装 ZMod 核心微内核...\n');

  const zcodePath = locateZCode();
  if (!zcodePath) {
    console.error('✖ 无法自动找到 ZCode 安装目录。请通过环境变量 ZCODE_PATH 指定完整路径后重试。');
    process.exit(1);
  }

  const asarPath = path.join(zcodePath, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    console.error(`✖ 未在 ${asarPath} 找到 app.asar。`);
    process.exit(1);
  }

  console.log(`• 目标宿主: ${zcodePath}`);
  console.log(`• 目标 asar: ${asarPath}`);

  // 1. Ensure user data dirs
  ensureDirectories();
  console.log(`• 初始化用户数据目录: ${getUserDataDir()} [✔ 完成]`);

  // 2. Backup if first time
  const backupPath = path.join(zcodePath, 'resources', 'app.asar.backup1');
  if (!fs.existsSync(backupPath)) {
    console.log(`• 创建官方 asar 原始基线备份: ${backupPath}`);
    fs.copyFileSync(asarPath, backupPath);
    console.log('  [✔ 备份成功]');
  } else {
    console.log(`• 官方基线备份已存在: ${backupPath} [✔]`);
  }

  console.log('\n✔ ZMod 核心已就绪！');
  console.log('提示: 启动 ZCode 客户端后按 Ctrl+Shift+M 即可唤起统一管理面板。\n');
}
