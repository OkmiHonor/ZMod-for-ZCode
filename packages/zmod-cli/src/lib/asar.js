import fs from 'node:fs';
import path from 'node:path';

let _asar = null;

/** @electron/asar is CommonJS; load lazily via ESM interop. */
export async function loadAsar() {
  if (!_asar) {
    const mod = await import('@electron/asar');
    _asar = mod.default ?? mod;
  }
  return _asar;
}

export const UNPACK_GLOB = '**/node_modules/@(node-pty|ssh2)/**/@(*.node|*.dll|*.exe)';

/**
 * Scan raw asar bytes for marker strings. Works because every stored file's
 * bytes live contiguously inside the single archive file.
 */
export function findMarkers(archivePath, markers) {
  const buf = fs.readFileSync(archivePath);
  const found = [];
  for (const m of markers) {
    if (buf.includes(Buffer.from(m, 'utf8'))) found.push(m);
  }
  return found;
}

/** Walk an asar header tree and return the set of unpacked relative paths ('/'). */
export function unpackedSetFromHeader(header) {
  const out = [];
  const walk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, p);
      else if (child.unpacked) out.push(p);
    }
  };
  walk(header, '');
  return out.sort();
}

export async function getUnpackedSet(archivePath) {
  const asar = await loadAsar();
  const { header } = asar.getRawHeader(archivePath);
  return unpackedSetFromHeader(header);
}

/**
 * extractAll requires an `<archive>.unpacked` companion directory next to the
 * archive for unpacked entries. The live install has one; a standalone archive
 * (e.g. the pristine snapshot) does not, so we link it temporarily.
 */
export async function extractAll(archivePath, destDir, unpackedHint = null) {
  const asar = await loadAsar();
  const companion = `${archivePath}.unpacked`;
  let madeLink = false;
  if (!fs.existsSync(companion)) {
    const hint = unpackedHint && fs.existsSync(unpackedHint) ? unpackedHint : null;
    if (!hint) {
      throw new Error(`missing unpacked companion for ${archivePath} (and no hint provided)`);
    }
    try {
      fs.symlinkSync(hint, companion, 'junction');
    } catch {
      fs.symlinkSync(hint, companion, 'dir');
    }
    madeLink = true;
  }
  try {
    await asar.extractAll(archivePath, destDir);
  } finally {
    if (madeLink) {
      try {
        fs.rmSync(companion, { recursive: true });
      } catch {}
    }
  }
}

/**
 * Pack srcDir into outFile and verify the unpacked set matches the reference
 * archive exactly — node-pty/ssh2 native binaries must never end up inside
 * the asar (breaks the terminal) or go missing (breaks everything).
 */
export async function packAndVerify(srcDir, outFile, referenceArchive) {
  const asar = await loadAsar();
  await asar.createPackageWithOptions(srcDir, outFile, { unpack: UNPACK_GLOB });
  const expected = await getUnpackedSet(referenceArchive);
  const got = await getUnpackedSet(outFile);
  if (expected.length !== got.length || expected.some((p, i) => p !== got[i])) {
    const missing = expected.filter((p) => !got.includes(p));
    const extra = got.filter((p) => !expected.includes(p));
    throw new Error(
      `unpacked set mismatch: missing=${JSON.stringify(missing.slice(0, 5))} extra=${JSON.stringify(extra.slice(0, 5))}`
    );
  }
  return got.length;
}

/** Extract a single file from an archive as a Buffer. */
export async function extractFile(archivePath, relPath) {
  const asar = await loadAsar();
  return asar.extractFile(archivePath, relPath.split('/'));
}

/** Read the host app version from the asar's package.json. */
export async function readHostVersion(archivePath) {
  try {
    const buf = await extractFile(archivePath, 'package.json');
    return JSON.parse(buf.toString('utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}
