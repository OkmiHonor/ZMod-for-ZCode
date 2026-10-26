// ZMod 官方插件注册表：search / update / 主进程 plugin-host 的唯一事实源，
// 随仓库 main 分支发布。双源顺序尝试（GitHub raw 主源 + jsdelivr CDN 镜像），
// 先成功者用；两源都失败时调用方回退本地缓存。
export const REGISTRY_URLS = [
  'https://raw.githubusercontent.com/OkmiHonor/ZMod-for-ZCode/main/registry.json',
  'https://cdn.jsdelivr.net/gh/OkmiHonor/ZMod-for-ZCode@main/registry.json'
];

// 旧名保留：单值场景（如 CLI 展示主源 URL）仍引用主源
export const REGISTRY_URL = REGISTRY_URLS[0];

export const GITHUB_RELEASE_MIRRORS = [
  '',
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://mirror.ghproxy.com/'
];

export function buildDownloadCandidateUrls(rawUrl, customMirror = process.env.ZMOD_GITHUB_MIRROR) {
  const url = String(rawUrl || '').trim();
  if (!url) return [];
  const isGithubEligible =
    /^https:\/\/(?:github\.com\/[^/]+\/[^/]+\/releases\/download\/|raw\.githubusercontent\.com\/)/i.test(url);
  if (!isGithubEligible) return [url];

  const custom = typeof customMirror === 'string' ? customMirror.trim() : '';
  const prefixes = custom
    ? [custom.endsWith('/') ? custom : `${custom}/`, ...GITHUB_RELEASE_MIRRORS]
    : [...GITHUB_RELEASE_MIRRORS];

  const seen = new Set();
  const candidates = [];
  for (const p of prefixes) {
    const cand = p === '' ? url : `${p.endsWith('/') ? p : `${p}/`}${url}`;
    if (!seen.has(cand)) {
      seen.add(cand);
      candidates.push(cand);
    }
  }
  return candidates;
}

