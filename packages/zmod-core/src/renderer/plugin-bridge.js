/**
 * 渲染层插件热装载桥：把主进程 plugin-host 的 zmod:plugin-changed 广播
 * 翻译成本地 PluginRegistry 的装载/卸载动作。
 *
 * 纯决策（decideLoadAction）与副作用执行（applyPluginChange）分离，
 * 依赖全部注入，可在 Node 单测中离线验证。
 */

/**
 * 依据广播 action 与本地注册状态决定动作。enabled 不参与决策——
 * 它只影响 applyPluginChange 在 load/reload 后是否 enable。
 *
 * @param {'installed'|'updated'|'removed'} action
 * @param {{ registered: boolean, active: boolean, enabled: boolean }} state
 * @returns {{ op: 'load'|'reload'|'unload'|'noop', reason?: string }}
 */
export function decideLoadAction(action, state) {
  const registered = Boolean(state?.registered);
  switch (action) {
    case 'installed':
      return registered ? { op: 'noop', reason: 'already-registered' } : { op: 'load' };
    case 'updated':
      return registered ? { op: 'reload' } : { op: 'load' };
    case 'removed':
      return registered ? { op: 'unload' } : { op: 'noop', reason: 'not-registered' };
    default:
      return { op: 'noop', reason: 'unknown-action' };
  }
}

/**
 * 执行一条插件变更广播。永不抛错：失败走 onError 旁路并返回 { applied:false, error }。
 *
 * @param {{ action: string, id: string, entryUrl: string|null, manifest: object }} payload
 * @param {{ registry: object, invoke: Function, importModule: Function, getConfig: Function, onError?: Function }} deps
 *   registry: PluginRegistry 实例（getAll/isActive/register/enable/disable/unregister）
 *   importModule: (url) => Promise<module>，生产环境即动态 import()
 *   getConfig: () => Promise<object>，等价 config.get 的结果
 * @returns {Promise<{ applied: boolean, op?: string, reason?: string, error?: unknown }>}
 */
export async function applyPluginChange(payload, deps) {
  const { registry, importModule, getConfig, onError } = deps;
  const id = payload?.id;
  try {
    let registered = false;
    try {
      registered = registry.getAll().some((d) => d && d.id === id);
    } catch {}
    let active = false;
    try {
      active = registry.isActive(id);
    } catch {}

    let enabled = true;
    try {
      const cfg = (await getConfig()) || {};
      enabled = cfg.plugins?.[id]?.enabled ?? true;
    } catch {}

    const decision = decideLoadAction(payload?.action, { registered, active, enabled });
    if (decision.op === 'noop') {
      return { applied: true, op: 'noop', reason: decision.reason };
    }

    if (decision.op === 'unload') {
      if (active) await registry.disable(id);
      registry.unregister(id);
      return { applied: true, op: 'unload' };
    }

    // load / reload：import 新 entryUrl（?v= 防缓存）→ 覆盖注册 → 按 enabled 决定启停
    const mod = await importModule(payload.entryUrl);
    const def = mod && (mod.default || mod);
    if (registered && active) await registry.disable(id);
    registry.register(def);
    if (enabled) await registry.enable(id);
    return { applied: true, op: decision.op };
  } catch (err) {
    try {
      onError?.(err);
    } catch {}
    return { applied: false, error: err };
  }
}
