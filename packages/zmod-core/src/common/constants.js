// ZMod 官方插件注册表：search / update / 主进程 plugin-host 的唯一事实源，
// 随仓库 main 分支发布。双源顺序尝试（GitHub raw 主源 + jsdelivr CDN 镜像），
// 先成功者用；两源都失败时调用方回退本地缓存。
export const REGISTRY_URLS = [
  'https://raw.githubusercontent.com/OkmiHonor/ZMod-for-ZCode/main/registry.json',
  'https://cdn.jsdelivr.net/gh/OkmiHonor/ZMod-for-ZCode@main/registry.json'
];

// 旧名保留：单值场景（如 CLI 展示主源 URL）仍引用主源
export const REGISTRY_URL = REGISTRY_URLS[0];
