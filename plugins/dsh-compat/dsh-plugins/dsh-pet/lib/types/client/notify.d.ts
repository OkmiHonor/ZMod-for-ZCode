/** 图标 URL 表（设置页「获取权限」成功确认的测试通知也用）——文件名单一来源在 shared */
export declare const NOTIFY_ICONS: {
    readonly done: string;
    readonly error: string;
    readonly truncated: string;
    readonly approval: string;
    readonly question: string;
    readonly test: string;
};
/**
 * 会话跳转器：由 app.ts 装配时注入（包装 DSH 客户端的 `uiWorkspace.openSession`）。
 * 抽成接口是为了让本模块不 direct 依赖 DSH 服务类型，取不到服务时天然退化成"不跳会话"。
 */
export interface SessionNavigator {
    openSession(sessionId: string): void;
}
/**
 * 点通知 → 切到那条会话 + 聚焦页面 + 请桌面壳把主窗口叫回前台。
 *
 * 1. `openSession(sessionId)`：**页内**切会话。只改前端状态，窗口还在后台也能切——先切再叫窗口，
 *    用户看到窗口的那一刻就是目标会话，不会先闪一下旧对话；
 * 2. `window.focus()`：浏览器宿主下由浏览器把页签带到前台；
 * 3. 隐藏 iframe 导航 `dsh://open`：页面只能聚焦自己这一层，恢复不了**最小化**的宿主窗口
 *    （那是 Electron 主进程的事）→ 协议 → 第二实例锁 → `focusPrimaryWindow()`。零子进程、零新接口。
 *    只在 Electron 宿主里发：浏览器里导航 `dsh://` 会弹拦截框，而浏览器点通知本来就会带前页签。
 *
 * `sessionId` 缺失（旧版宿主 / 拿不到会话位置的事件）时跳过第 1 步，其余照旧。
 */
export declare function wireNotificationClick(n: Notification, sessionId?: string): void;
/** 申请浏览器通知权限的结果：ok=true 已授予；ok=false 带失败原因（供设置页红字展示） */
export type PermissionResult = {
    ok: true;
} | {
    ok: false;
    reason: 'unsupported' | 'denied' | 'rejected' | 'error';
    message?: string;
};
/** 申请浏览器通知权限。务必在用户手势（点击）下调用——无手势的自动申请可能被浏览器静默压制；
 * 失败时区分原因：unsupported=环境无 Notification、denied=浏览器已标记阻止、
 * rejected=用户在询问弹窗里选了阻止、error=申请过程异常/弹窗被跳过。 */
export declare function requestNotificationPermission(): Promise<PermissionResult>;
/** 重读总开关（设置页保存开关后调用）；之后新触发的通知按新值执行，无需刷新页面 */
export declare function reloadNotifications(): Promise<void>;
/**
 * 一帧通知 → toast（帧映射来自 shared；未知帧静默跳过）。
 * 由容器统一轮询 /state 后、发现 sections.notify 的 counter 变化时调用——
 * 通知不再有独立的 1s 轮询循环（改造前是 /notify?since=<seq> 拉增量帧数组）。
 */
export declare function notifyFromFrame(frame: unknown): void;
/**
 * 初始化系统通知引擎（**不做轮询**）：读总开关 + 兜底申请权限 + 跟踪页面聚焦 + 记住会话跳转器。
 * 帧的消费改为容器统一轮询 /state 后调 notifyFromFrame（见 pet.ts 的分发）。
 * 返回释放函数（摘掉聚焦监听），由 ctx.effect 在插件卸载时调用。
 * @param navigator 会话跳转器（app.ts 包装 DSH 的 uiWorkspace）；不传 = 点击只叫窗口、不跳会话
 */
export declare function initNotify(navigator?: SessionNavigator): () => void;
