/**
 * 位置 / 抛掷指令（`POST /dsh-pet-7340/position`、`POST /dsh-pet-7340/throw`）的**纯决策层**。
 *
 * 与 ./anim 同一分工：只判定"该不该受理、受理成什么"，不碰 HTTP、不碰 S，可完全离线单测。
 *
 * 抛掷**不引入任何新行为**：复用前端的 `startThrow`（参数换算成初速度），重力、反弹、地面摩擦、
 * 落地 Q 弹、宠物间碰撞等全部是既有行为。位置由 `mode` 三选一决定走哪条路（见 decidePosition），
 * 三条路同样是渲染端既有的运动学。所以本层一概不管运动，只剩两件事：**参数校验**与**坐标夹取**。
 */
/** 受理失败的分类（路由原样透出给调用方，与 ./anim 用同一套词汇） */
export type MotionFailure = 'bad-request' | 'pet-required' | 'unknown-pet';
/**
 * 位置指令的运动模式（三选一）。
 * **与 shared/state.ts 的同名联合体是两份**——宿主不 import src/shared（同 `Corner` 的处理方式），
 * 改动时两边要一起改。
 */
export type PositionMode = 'instant' | 'spring' | 'line';
/** 合法模式集合：校验与错误信息共用一份，避免两处各写一遍 */
export declare const POSITION_MODES: readonly PositionMode[];
/** 位置决策结论：通过则给出最终要写进 S 的内容（`duration` 为 `null` = 该模式不用时间） */
export type PositionDecision = {
    ok: true;
    petId: string;
    x: number;
    y: number;
    mode: PositionMode;
    duration: number | null;
} | {
    ok: false;
    reason: MotionFailure;
    message: string;
};
/** 抛掷决策结论 */
export type ThrowDecision = {
    ok: true;
    petId: string;
    angle: number;
    power: number;
} | {
    ok: false;
    reason: MotionFailure;
    message: string;
};
/**
 * 把外部给的位置请求核对成一个结论。
 *
 * `x`/`y` 是宠物**中心**的归一化坐标（0~1）。选中心而不是左上角：前端持久位置 `customPos`
 * 存的就是中心（`rx = (px + halfW) / W`），且调用方不必知道宠物多大。
 *
 * `mode` **必填**，三种运动模式（三条路都是渲染端既有运动学，宿主只负责选路）：
 *
 *   - `instant`：一帧到位；
 *   - `spring`：拖拽跟手那套过阻尼弹簧（`springStep`）平滑追过去；
 *   - `line`：**按 `duration` 毫秒直线走到**——该模式下 `duration` **必填**（非负有限数，
 *     `0` = 立即到位）。
 *
 * `instant` / `spring` 给了 `duration` 也**不看**：调用方常把 body 模板整个复用，为此报错只会
 * 逼他们删字段。
 *
 * 校验顺序：`x`/`y` → `mode` → `duration` → 宠物解析。参数是调用方的错，先纠它。
 */
export declare function decidePosition(args: {
    cfg: Record<string, Record<string, unknown>>;
    /** `?pet=` 的原值（**必填**：空串 → `pet-required`） */
    requested: string;
    x: unknown;
    y: unknown;
    /** 必填：`instant` / `spring` / `line` */
    mode?: unknown;
    /** 仅 `line` 模式必填：行程时间（毫秒），非负有限数，`0` = 立即到位 */
    duration?: unknown;
}): PositionDecision;
/**
 * 决策结论 → 写进 S 叶子的载荷。**非 `line` 模式不带 `duration`**：叶子形状本身就是语义
 * （有 `duration` 就是"按时间走直线"），也省得前端去读一个恒为 `0` 的字段。
 */
export declare const positionLeafData: (d: {
    x: number;
    y: number;
    mode: PositionMode;
    duration: number | null;
}) => Record<string, unknown>;
/**
 * 把外部给的抛掷请求核对成一个结论。
 *
 * `angle` 单位度，`0` = 正右、**逆时针为正**（屏幕坐标 y 向下，所以这是数学惯例而非屏幕惯例：
 * "往上抛"写 90）。这里**不做角度归一化**——前端换算成 vx/vy 时 sin/cos 对任意实数都成立。
 *
 * `power` 是力度倍率（`1.0` = 1200 px/s 软钳速**前**，实际初速会被既有软上限压到约 1021）。
 * **不设死区**：拖拽松手时低于 500 px/s 算"温柔放下"，那是拖拽语义；接口是明确命令，再小也照抛。
 */
export declare function decideThrow(args: {
    cfg: Record<string, Record<string, unknown>>;
    /** `?pet=` 的原值（**必填**：空串 → `pet-required`） */
    requested: string;
    angle: unknown;
    power: unknown;
}): ThrowDecision;
