#!/usr/bin/env node
/**
 * Electron fuse 哨兵扫描 —— 熔断报警（asar 完整性锁早期预警）
 *
 * 原理：@electron/fuses 把哨兵串 dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX 写进主程序，
 * 其后紧跟 [版本字节][熔断线长度字节][熔断线 N 字节]，每字节状态：
 *   0=REMOVED 1=INHERIT 2=ENABLE 3=DISABLE
 * 与本工具链生死相关的两位：
 *   [4] EnableEmbeddedAsarIntegrityValidation（asar 头哈希烧入 exe，改动 asar 即拒绝加载）
 *   [5] OnlyLoadAppFromAsar（只允许从 asar 加载应用）
 * 任一为 ENABLE ⇒ 重建 asar 无法启动客户端 ⇒ 禁止部署。
 */
const fs = require('fs');

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
const IDX = { EnableEmbeddedAsarIntegrityValidation: 4, OnlyLoadAppFromAsar: 5 };
// 官方 @electron/fuses constants.ts 权威编码（非 0-3 整数）：DISABLE=0x30('0') ENABLE=0x31('1') REMOVED=0x72 INHERIT=0x90
const STATE = { 0x30: 'DISABLE', 0x31: 'ENABLE', 0x72: 'REMOVED', 0x90: 'INHERIT' };

function scanExe(exePath) {
  const buf = fs.readFileSync(exePath);
  const i = buf.indexOf(SENTINEL);
  if (i < 0) return { found: false, exe: exePath };
  const ver = buf[i + SENTINEL.length];
  const len = buf[i + SENTINEL.length + 1];
  const wireStart = i + SENTINEL.length + 2;
  const fuses = {};
  for (const [name, idx] of Object.entries(IDX)) {
    const b = idx < len ? buf[wireStart + idx] : null;
    fuses[name] = { byte: b, state: b == null ? 'ABSENT' : STATE[b] || 'UNKNOWN(' + b + ')' };
  }  const tripped = Object.values(fuses).some((f) => f.state === 'ENABLE');
  return { found: true, exe: exePath, version: ver, wireLen: len, fuses, tripped };
}

module.exports = { scanExe };

if (require.main === module) {
  const exe = process.argv[2];
  if (!exe) {
    console.error('用法: node tools/check-fuses.cjs <ZCode.exe 路径>');
    process.exit(1);
  }
  try {
    const r = scanExe(exe);
    if (!r.found) console.log('[fuse] 未嵌入 fuse 哨兵（未配置熔断，asar 可自由重建）');
    else {
      console.log('[fuse] 哨兵已找到 v' + r.version + ' wireLen=' + r.wireLen);
      for (const [k, v] of Object.entries(r.fuses)) console.log('  [' + k + '] byte=' + v.byte + ' → ' + v.state);
      console.log(r.tripped ? '[fuse] ⚠ 熔断已开启！' : '[fuse] 熔断未启用 ✔');
      process.exit(r.tripped ? 1 : 0);
    }
  } catch (e) {
    console.error('[fuse][FAIL]', e.message);
    process.exit(2);
  }
}
