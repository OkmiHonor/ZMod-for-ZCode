import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function locateZCode() {
  if (process.env.ZCODE_PATH && fs.existsSync(process.env.ZCODE_PATH)) {
    return path.resolve(process.env.ZCODE_PATH);
  }

  const candidates = [];
  const home = os.homedir();

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    candidates.push(
      path.join(localAppData, 'Programs', 'ZCode'),
      path.join(progFiles, 'ZCode'),
      path.join(progFilesX86, 'ZCode'),
      'D:\\ZCode',
      'C:\\ZCode'
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/ZCode.app/Contents/Resources',
      path.join(home, 'Applications/ZCode.app/Contents/Resources')
    );
  } else {
    candidates.push(
      '/usr/lib/zcode',
      '/opt/zcode',
      path.join(home, '.local/share/zcode')
    );
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      // Validate that it has ZCode.exe or resources/app.asar
      if (
        fs.existsSync(path.join(p, 'resources', 'app.asar')) ||
        fs.existsSync(path.join(p, 'app.asar')) ||
        fs.existsSync(path.join(p, 'ZCode.exe'))
      ) {
        return p;
      }
    }
  }

  return null;
}
