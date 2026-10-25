import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { locateZCode, findAsarInHost, findHostExe } from '../locate.js';
import { findMarkers, readHostVersion } from '../lib/asar.js';
import { MARKERS, V1_MARKERS } from '../patches/index.js';
import { isZcodeRunning } from '../lib/process.js';
import {
  getUserDataDir,
  getConfigPath,
  getPluginsDir,
  getRuntimeDir,
  getBaseSnapshotPath
} from '../../../zmod-core/src/common/paths.js';
import { configManager } from '../../../zmod-core/src/common/config.js';

/* ---- Electron fuse sentinel (ported from the v1 toolchain check-fuses.cjs) ---- */
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
const FUSE_IDX = { EnableEmbeddedAsarIntegrityValidation: 4, OnlyLoadAppFromAsar: 5 };
const FUSE_STATE = { 0x30: 'DISABLE', 0x31: 'ENABLE', 0x72: 'REMOVED', 0x90: 'INHERIT' };

function scanFuses(exePath) {
  const buf = fs.readFileSync(exePath);
  const i = buf.indexOf(FUSE_SENTINEL);
  if (i < 0) return { found: false };
  const wireLen = buf[i + FUSE_SENTINEL.length + 1];
  const wireStart = i + FUSE_SENTINEL.length + 2;
  const fuses = {};
  let tripped = false;
  for (const [name, idx] of Object.entries(FUSE_IDX)) {
    const b = idx < wireLen ? buf[wireStart + idx] : null;
    const state = b == null ? 'ABSENT' : FUSE_STATE[b] || `UNKNOWN(${b})`;
    fuses[name] = state;
    if (state === 'ENABLE') tripped = true;
  }
  return { found: true, fuses, tripped };
}

const mark = (ok, label, detail = '') =>
  console.log(`  [${ok ? '✔' : '✖'}] ${label}${detail ? ' — ' + detail : ''}`);

export async function doctor(opts = {}) {
  console.log(`\n🩺 [ZMod Doctor] v${createRequire(import.meta.url)('../../package.json').version} 诊断报告\n`);
  let failures = 0;

  console.log('• 环境');
  console.log(`  Node ${process.version} · ${process.platform}/${process.arch}`);

  const hostDir = locateZCode({ explicit: opts.path });
  const asarPath = hostDir ? findAsarInHost(hostDir) : null;
  if (!asarPath) {
    console.log('• 宿主');
    mark(false, 'ZCode 安装目录未找到（--path / ZCODE_PATH / 常见路径均未命中）');
    failures++;
  } else {
    const version = await readHostVersion(asarPath);
    console.log(`• 宿主: ${asarPath} (ZCode ${version}, ${(fs.statSync(asarPath).size / 1048576).toFixed(1)} MB)`);

    console.log('• asar 补丁标记');
    const v2 = findMarkers(asarPath, Object.values(MARKERS));
    const v1 = findMarkers(asarPath, V1_MARKERS);
    if (v1.length > 0) {
      mark(false, '检测到旧版 ZMod v1 内联魔改', v1.join(', '));
      failures++;
    } else {
      const expected = Object.values(MARKERS);
      const missing = expected.filter((m) => !v2.includes(m));
      if (v2.length === 0) {
        mark(false, '未安装 ZMod（官方纯净版）', '运行 zmod install');
      } else if (missing.length > 0) {
        mark(false, '补丁不完整', `缺少 ${missing.join(', ')}`);
        failures++;
      } else {
        mark(true, '四通道补丁齐全 (head/tail/preload/renderer)');
      }
    }

    console.log('• Electron 熔断哨兵');
    const exe = findHostExe(hostDir);
    if (!exe) {
      mark(true, '未找到主程序（跳过熔断扫描）');
    } else {
      const fuses = scanFuses(exe);
      if (!fuses.found) mark(true, '未嵌入熔断（asar 可自由重建）');
      else if (fuses.tripped) {
        mark(false, '熔断已开启 — 重建 asar 将无法启动客户端！', JSON.stringify(fuses.fuses));
        failures++;
      } else mark(true, '熔断未启用', JSON.stringify(fuses.fuses));
    }
  }

  console.log('• 外置运行时');
  const userData = getUserDataDir();
  const runtimeDir = getRuntimeDir();
  const runtimeFiles = [
    path.join(runtimeDir, 'main', 'index.js'),
    path.join(runtimeDir, 'main', 'protocol.js'),
    path.join(runtimeDir, 'main', 'rpc.js'),
    path.join(runtimeDir, 'common', 'paths.js'),
    path.join(runtimeDir, 'core', 'index.js'),
    path.join(runtimeDir, 'sdk', 'index.js'),
    path.join(runtimeDir, 'sdk', 'schema.js')
  ];
  const missingRuntime = runtimeFiles.filter((f) => !fs.existsSync(f));
  mark(missingRuntime.length === 0, missingRuntime.length === 0 ? 'runtime 文件齐全' : 'runtime 缺失文件', missingRuntime.join(', ') || runtimeDir);

  console.log('• 数据目录');
  console.log(`  用户数据: ${userData} [${fs.existsSync(userData) ? '存在' : '未初始化'}]`);
  console.log(`  配置文件: ${getConfigPath()} [${fs.existsSync(getConfigPath()) ? '存在' : '未创建'}]`);
  console.log(`  基线快照: ${getBaseSnapshotPath()} [${fs.existsSync(getBaseSnapshotPath()) ? '存在' : '无（restore 将不可用）'}]`);

  console.log('• 插件');
  const pluginsDir = getPluginsDir();
  if (!fs.existsSync(pluginsDir)) {
    mark(false, '插件目录不存在', '运行 zmod install 部署');
    failures++;
  } else {
    const ids = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    if (ids.length === 0) {
      mark(false, '插件目录为空');
      failures++;
    }
    for (const id of ids) {
      const enabled = configManager.isPluginEnabled(id);
      console.log(`  [${enabled ? '✔' : ' '}] ${id.padEnd(20)} ${enabled ? '启用' : '禁用'}`);
    }
  }

  console.log('• 客户端进程');
  console.log(`  ${isZcodeRunning() ? 'ZCode 正在运行（改 asar 前需退出或 --force）' : '未运行'}`);

  console.log(`\n${failures === 0 ? '✔ 诊断通过' : `✖ ${failures} 项异常`}\n`);
  if (failures > 0) process.exitCode = 1;
}
