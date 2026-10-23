import fs from 'node:fs';
import path from 'node:path';
import { locateZCode } from '../locate.js';

export async function restore() {
  console.log('\n🧹 [ZMod Restore] 正在还原为官方纯净客户端...\n');

  const zcodePath = locateZCode();
  if (!zcodePath) {
    console.error('✖ 无法自动找到 ZCode 安装目录。');
    process.exit(1);
  }

  const asarPath = path.join(zcodePath, 'resources', 'app.asar');
  const backupPath = path.join(zcodePath, 'resources', 'app.asar.backup1');

  if (!fs.existsSync(backupPath)) {
    console.error(`✖ 未找到原始备份 ${backupPath}，无法自动还原。`);
    process.exit(1);
  }

  try {
    fs.copyFileSync(backupPath, asarPath);
    console.log(`✔ 已将官方原始 asar 还原至: ${asarPath}`);
    console.log('客户端已恢复为官方纯净状态。\n');
  } catch (err) {
    console.error('✖ 还原失败:', err.message);
    process.exit(1);
  }
}
