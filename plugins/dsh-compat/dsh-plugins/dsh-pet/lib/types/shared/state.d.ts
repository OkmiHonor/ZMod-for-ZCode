import { type BalanceState } from './balance';
import { type WorkStatusSnapshot } from './work-status';
/** 一个叶子：计数器 + 载荷（data 为 null = 还没有数据，消费端跳过） */
export interface StateLeaf {
    counter: number;
    data: unknown;
}
/** S 的客户端视图（叶子已规范化：counter 必为数字） */
export interface PollState {
    /** 整份 S 的版本号（= 最后一次写入的编号）。回传成 `?since=` 表达"我手里这份是哪个版本"。
     *  **老宿主不带此字段** → undefined：消费端据此退回定时轮询——老宿主不认识 since/timeout，
     *  会立刻返回，不退避就变成狂打。 */
    counter?: number;
    sections: Record<string, StateLeaf>;
    pets: Record<string, Record<string, StateLeaf>>;
}
/** 一次变化的叶子（path 用于日志/调试，leaf 用于渲染） */
export interface StateChange {
    path: string;
    leaf: StateLeaf;
}
/**
 * 拉一次 /state。
 * 失败 / HTTP 非 2xx / 形状不对 → null（轮询侧静默重试，与其余轮询同一容错口径）。
 *
 * `wait` 传了就带 `?since=&timeout=` 走**长轮询**：宿主在"版本没变"时挂起，直到任意叶子被写过
 * （立刻返回）或超时。不传 = 立刻返回全量（改造前的语义）。
 */
export declare function fetchState(baseUrl?: string, wait?: {
    since: number;
    timeoutMs: number;
}): Promise<PollState | null>;
/** S → { 叶子路径: counter }：首拉基线用（新增的 section/宠物自动纳入，不用改这里） */
export declare function flattenCounters(s: PollState): Record<string, number>;
/**
 * 与基线比对，**就地推进基线**，返回本次变化的叶子。
 * 首拉不要调它（用 flattenCounters 记基线即可）——否则页面刷新会把旧数据重放一遍。
 */
export declare function takeChanged(s: PollState, baseline: Record<string, number>): StateChange[];
/**
 * 类型收窄：余额叶子 → `{ state, manual }`。
 * `manual` = 这次写入是**手动触发**的（`/balance` 命令、桌面「查看余额」菜单）——
 * 由 host 在写入时标记（`{...result, manual: true}`），因为只有 host 知道这次刷新是谁要的。
 * 消费端据此决定"余额不可用时要不要必弹文字说明"（decideBalanceNotice 的 explicit 参数）。
 * 形状非法 → null（消费端跳过这一拍，不抛）。
 */
export declare function readBalance(leaf: StateLeaf): {
    state: BalanceState;
    manual: boolean;
} | null;
/**
 * 说话指令（`pets.<id>.say` 的两种形态）：
 *
 * - `say`：弹一个气泡。`duration` = 显示时长（毫秒；缺省 10s，`0` = 字面意思「不显示」）；
 *   `anim` **只在显式 `false` 时出现**，表示这次不联动 `events.whisper` 动画、只弹气泡。
 * - `clear`：收起当前气泡（`POST /bubble/clear` 的落点）。**必须单独一个形态**——
 *   空文本会被本函数判成非法、整拍跳过，表达不了"清空"这个动作。
 *
 * 配图两种形态**并列、由字段名区分**（issue #122 第 1 条的"资源注册"）：`image` = 该条目
 * 表情包池内的名称（消费端拼 `<base>/pic/memes/<素材根>/<名>.png`），`url` = 第三方给的完整地址
 * （消费端直接用它）。**不做「一个中性字段装两种值」**——消费端必须知道该不该拼路径，字段名
 * 本身就是那个判别位，靠 `startsWith('http')` 嗅探会在名字恰好长得像 URL 时出错。
 */
export type SayCue = {
    kind: 'say';
    text: string;
    image?: string;
    url?: string;
    duration?: number;
    anim?: boolean;
} | {
    kind: 'clear';
};
/**
 * 类型收窄：宠物说话叶子 → SayCue（形状非法 / 空文本 → null，消费端跳过这一拍）。
 * 碎碎念、命令气泡、对话回复共用这一个叶子——前端本来就是同一条展示链路
 * （同一个 triggerWhisper、同一个气泡槽、同一批 events.whisper 动画）。
 * `duration` / `anim` 缺省即**老行为**（10s + 联动），所以老 host 写的叶子照常能读。
 */
export declare function readSay(leaf: StateLeaf): SayCue | null;
/**
 * 类型收窄：工作状态叶子 → 快照（形状非法 → null，消费端跳过这一拍）。
 * 与余额不同，这里没有"手动"标记：工作状态永远由 DSH 事件驱动，没有用户主动要的那条路。
 */
export declare function readWorkStatus(leaf: StateLeaf): WorkStatusSnapshot | null;
/**
 * 朝向：`left` = 素材原样，`right` = 镜像（渲染端贴 `scaleX(-1)`）。
 * **与 host/anim.ts 的同名联合体是两份**——宿主不 import src/shared（同 `Corner`、`PositionMode`
 * 的处理方式），改动时两边要一起改。
 */
export type PetFacing = 'left' | 'right';
/**
 * 类型收窄：点播动画叶子 → 动画名**或**地址 + 回执编号（两者都空 → null，消费端跳过这一拍）。
 * **两种形态并列、由字段名区分**（issue #122 第 1 条）：
 *   - `name`：该宠物动画池内的名字，**名字即文件名**，消费端拼 `/thumb/<素材根>/<名>.webm` 换源，
 *     并走菜单动作处理函数（镜像修正 / 移动类走真实位移等菜单语义）；
 *   - `url`：第三方给的**完整地址**（scheme 已由宿主卡在 http/https），消费端直接换源播一次，
 *     **不走菜单语义**——裸地址没有"是不是文字类 / 是不是移动类"这些属性。
 * "这个动画是否存在于该宠物"由宿主在写入前保证（播放端对不存在的名字没有兜底）。
 * `playbackId`：宿主受理时生成的回执编号（issue #122），渲染端拿它在播放的四个时机
 * 上报真实状态（见 /playback 路由）。老 host 不写这个字段 → undefined，消费端按"无回执"处理。
 * `facing`：调用方**显式指定**的朝向（可选）。`undefined` = 没指定 → 消费端**不动朝向**，
 * 保持宠物当前朝向——**不是**"回落 left"（叶子写端只在显式给了时才写这个字段，所以"没要求"
 * 与"要求 left"在形状上就是可区分的）。两种形态都适用。
 */
export declare function readAnim(leaf: StateLeaf): {
    name?: string;
    url?: string;
    playbackId?: string;
    facing?: PetFacing;
} | null;
/**
 * 占用锁叶子（`pets.<id>.lock`）的形态（issue #122 第 4 项）：
 * `{ locked: true, expiresAt }` = 这只宠物正被第三方占用；`{ locked: false }` = 没有占用。
 */
export type LockState = {
    locked: true;
    expiresAt: number;
} | {
    locked: false;
};
/**
 * 类型收窄：占用锁叶子 → `LockState`（形状非法 → null，消费端跳过这一拍）。
 *
 * **这是状态，不是指令**（与 anim / position / throw 那三个不同）：宿主写、渲染端读来决定
 * "要不要冻结自己"——随机链不掷骰、暂停自播动画、忽略**自动**来源的余额与工作状态表现。
 * 宿主停不掉一段正在播的视频，所以"完全静止"最终是渲染端执行的。
 *
 * **宿主不会到点推一次"锁没了"**：`expiresAt` 是唯一真相，渲染端据此**自己**定时解除
 * （宿主侧的过期是懒判的，见 src/host/lock.ts）。因此读到 `expiresAt` **已经过去**就等于没有锁
 * ——页面刷新后才读到一份陈旧叶子时，必须按这个判，不能只看 `locked`。
 *
 * **不含 `lockId`**：那是持锁者的凭证，不能放进人人可读的 /state。
 */
export declare function readLock(leaf: StateLeaf): LockState | null;
/**
 * 位置指令的运动模式（三选一）。**与 host/motion-cue.ts 的同名联合体是两份**——宿主不 import
 * src/shared（同 `Corner` 的处理方式），改动时两边要一起改。
 */
export type PositionMode = 'instant' | 'spring' | 'line';
/**
 * 类型收窄：位置指令叶子 → `{ x, y, mode, duration }`（形状非法 → null，消费端跳过这一拍）。
 * **这是指令不是状态上报**：host 写、前端读来挪宠物，前端不往回写。
 * `x`/`y` 是宠物**中心**的归一化坐标（0~1，host 写入前已夹取）；
 * `mode` 决定走哪条路（instant 一帧到位 / spring 过阻尼弹簧 / line 按 duration 直线走到）；
 * `duration` **只有 `line` 模式才在叶子里**，其余模式恒为 `0`（它们本来就不用时间）。
 */
export declare function readPosition(leaf: StateLeaf): {
    x: number;
    y: number;
    mode: PositionMode;
    duration: number;
} | null;
/**
 * 类型收窄：抛掷指令叶子 → `{ angle, power }`（形状非法 → null，消费端跳过这一拍）。
 * `angle` 单位**度**（`0` = 正右，逆时针为正）；`power` 是力度倍率（`1.0` = 1200 px/s 软钳速前）。
 * 同样是**指令**，前端不往回写。
 */
export declare function readThrow(leaf: StateLeaf): {
    angle: number;
    power: number;
} | null;
/**
 * 动作端点：POST 一次，返回是否成功（`{ok:true}`）。
 * 动作**不返回数据**——数据只有一个出口（/state）。调用方**不需要**在收到 ok 后再做什么：
 * 这些动作都会写叶子 → 顶层 `counter` 变 → 挂着的长轮询那一拍立刻返回，结果 0 延迟到达。
 * （改造前这里靠"前端主动叫醒一拍"，长轮询上线后那套已经删掉了。）
 */
export declare function postAction(baseUrl: string, body?: unknown): Promise<boolean>;
