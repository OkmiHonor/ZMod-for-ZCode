import type { PhysicsParams, Rect } from './types';
/** 拖拽弹簧刚度：越大跟手越紧 */
export declare const SPRING_K = 200;
/** 拖拽弹簧阻尼：ζ = c/(2√k) ≈ 1.06，过阻尼，不 overshoot */
export declare const SPRING_C = 30;
/** 拖拽轨迹保留窗口（ms）：只留最近这一段做初速估算 */
export declare const TRAIL_KEEP_MS = 200;
/** 初速估算窗口（ms） */
export declare const RELEASE_WINDOW_MS = 150;
/** 松手前停顿超过它 = 温柔放下（不带残余速度），即使之前甩过 */
export declare const RELEASE_STALE_MS = 150;
/** 窗口太短视为不可估算（ms） */
export declare const MIN_SPAN_MS = 20;
/** 分段速度的最小 dt（ms）：高回报率鼠标事件可低至 1ms，过小 dt 会把抖动放大成虚假峰值，短段向前合并 */
export declare const SEG_MIN_DT_MS = 8;
/** 低于此速度 = 不抛（原地放下），px/s */
export declare const DEAD_ZONE_SPEED = 500;
/** 甩出速度软上限（px/s）：cap*(1-e^(-s/cap))，任意力度下仍单调可区分，渐近不超过 cap */
export declare const MAX_THROW_SPEED = 3600;
/** 初速大小 = 端点均值*(1-w) + 窗口峰值*w（弥补快甩时位移集中在窗口内一小段的低估） */
export declare const PEAK_WEIGHT = 0.5;
/** 参考加速度（px/s²）：末段加速达到它即吃满增益 */
export declare const ACCEL_REF = 8000;
/** 加速度增益上限：仍在加速的甩动最多放大 60% */
export declare const ACCEL_GAIN_MAX = 0.6;
/** 抛掷重力（px/s²） */
export declare const GRAVITY = 1400;
/** 碰边恢复系数：每次反弹保留约 78% 速度 */
export declare const RESTITUTION = 0.78;
/** 地面水平摩擦（/s） */
export declare const GROUND_FRICTION = 2.5;
/** 抛掷物理的默认参数（与内置配置一致；仅作配置缺失时的兜底） */
export declare const DEFAULT_PHYSICS: PhysicsParams;
/** 总力度默认量（throwPower=1 即现状） */
export declare const DEFAULT_THROW_POWER = 1;
/** 落地时 |vy| 小于它直接停竖直 */
export declare const REST_VY = 40;
/** 地面上 |vx| 小于它认为已静止 */
export declare const REST_VX = 15;
/** 单步最大 dt（s）：防后台标签页/卡顿后恢复的巨帧跳变 */
export declare const MAX_STEP_DT = 0.05;
/** 下压幅度：高度压到 55%（3 倍力度：原压深 15% → 现压深 45%，可继续调） */
export declare const SQ_SQUASH = 0.55;
/** 挤压时长（ms） */
export declare const SQ_DURATION_MS = 220;
/** 落地冲击速度基准：低于此 = 轻落（按下限幅度） */
export declare const SQ_SOFT_SPEED = 300;
/** 落地冲击速度上限：达到/超过此 = 重砸（吃满最大下压） */
export declare const SQ_HARD_SPEED = 1500;
/** 落地最大下压幅度（与点击一致）；轻落下限 0.8——重力 1400px/s²、恢复 0.78 下典型落地速度
 *  400~1500px/s，映射太保守会让常规甩抛的落地 Q 弹回到"不明显"，故底部留底限 */
export declare const SQ_MAX_SQUASH = 0.55;
/**
 * 落地冲击速度 → 下压幅度 scaleY 值（速度越大压得越狠）。
 * 返回作为 startSquash 的 squash 参数，曲线仍走 squashScale（u 进度不变）。
 */
export declare const landingSquash: (impactSpeed: number) => number;
/**
 * Q 弹挤压曲线：u∈[0,1] 进度 → scaleY 值。
 * 下压段（0~0.45）ease-in 压缩；回弹段（0.45~1）easeOutBack 带回弹过冲（~4%）。
 * 两端共用同一曲线，手感严格一致。
 */
export declare const squashScale: (u: number, squash?: number) => number;
/** 一次轨迹采样（t = performance.now() 时间戳 ms；x/y = 指针绝对坐标 px） */
export interface DragSample {
    t: number;
    x: number;
    y: number;
}
/** 抛掷边界：包围盒左上角的允许活动范围（与浏览器 rootStyle / 桌面 position 同一套「身体贴边」语义） */
export interface ThrowBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}
/** 抛体当前状态（包围盒左上角 px + 速度 px/s） */
export interface ThrowState {
    x: number;
    y: number;
    vx: number;
    vy: number;
}
/** 由 W/H/size 计算抛掷碰撞边界：身体（盒内缩 sideAllow）贴屏幕边缘才反弹 */
export declare const throwBounds: (o: {
    W: number;
    H: number;
    size: number;
    sideAllow: number;
}) => ThrowBounds;
/** 同 throwBounds，但基于任意一块工作区矩形（原点不必是 0）。area 取整个视口时两者逐位相同。 */
export declare const throwBoundsIn: (area: Rect, size: number, sideAllow: number) => ThrowBounds;
/**
 * 抛掷空间：**每块屏一套 AABB**，而不是整个桌面一个大 AABB。
 * 不规则多屏布局下外接矩形含空洞，用它当边界会让宠物飞进不可见区域（见 shared/displays.ts 注释）。
 */
export interface ThrowSpace {
    /** 逐屏的包围盒左上角允许范围（与 areas 同序） */
    bounds: ThrowBounds[];
    /** 逐屏工作区（反弹/归属判定；任务栏把面板挖掉的条带不在此列） */
    areas: Rect[];
    /** 逐屏**完整面板**（含任务栏区，与 areas 同序）：越界侧「有没有邻屏」的探测用面板而非工作区——
     * 任务栏在屏与屏接缝处时，工作区之间会有一段条带不属于任何 workArea，把它当墙会让宠物
     * 永远穿不过上下叠放的屏（且反弹线停在任务栏上沿）。面板并集在真正错位的空洞处仍然是空的，
     * 「空洞是墙」的语义不受影响。缺省 = areas（老主进程/单屏退化为原行为） */
    panels: Rect[];
    /** 宠物包围盒宽 */
    size: number;
    /** 身体相对包围盒左右各内缩的量 */
    sideAllow: number;
}
/** 由工作区列表构造抛掷空间（单块屏时等价于 throwBounds） */
export declare const throwSpace: (o: {
    areas: Rect[];
    panels?: Rect[];
    size: number;
    sideAllow: number;
}) => ThrowSpace;
/** 宠物当前该归属哪块屏：身体中心所在屏，落在空洞里时取最近的一块 */
export declare const screenOfBox: (space: ThrowSpace, x: number, y: number) => number;
/** 剔除超过保留窗口的旧采样（顺带排序去重，调用前采样按时间追加即可） */
export declare const trimTrail: (trail: DragSample[], now: number) => DragSample[];
/** 过阻尼弹簧单轴速度步进：调用方随后 x += v*dt。
 *  power = 总力度（K/C 同乘：系统形态不变，收敛速度快 p 倍 = 跟手更贴/更松）。 */
export declare const springStep: (v: number, x: number, target: number, dt: number, power?: number) => number;
/** 软钳速：`cap*(1-e^(-s/cap))`，任意速度下单调可区分、渐近不超过 cap。
 *  导出供抛掷指令（`POST /throw` 的 power）复用——接口抛掷与拖拽甩抛走同一条限速，手感一致。 */
export declare const softClampSpeed: (speed: number) => number;
/** 抛掷指令的力度锚点：`power = 1.0` 对应软钳速**前**的 1200 px/s
 *  （实际初速会被软上限压到约 1021 px/s，见 softClampSpeed）。 */
export declare const THROW_SPEED_ANCHOR = 1200;
/**
 * 抛掷指令（`POST /dsh-pet-7340/throw` 的 `angle` + `power`）→ 初速度 (vx, vy)，px/s。
 *
 * `angle` 单位度，`0` = 正右，**逆时针为正**——屏幕坐标 y 向下，所以 `vy` 取负号
 * （"往上抛"写 90，而不是 270）。任意实数角度都成立（sin/cos 天然按 360 周期）。
 * 初速 = `power × THROW_SPEED_ANCHOR`，再过**既有软上限**：与拖拽甩抛同一条限速，
 * 所以任意 `power` 都单调可区分且恒不超过 `MAX_THROW_SPEED`。
 *
 * 两端（浏览器 overlay / 桌面 sprite）共用本函数，保证接口抛掷的初速换算严格一致。
 */
export declare const throwVelocity: (angleDeg: number, power: number) => {
    vx: number;
    vy: number;
};
/**
 * 弹弓的力度来源与拖拽甩抛是**两条独立的路**，物理侧完全共用：
 * 这里只把「拉距」换成初速度，之后照样交给 startThrow → throwStep / throwStepRegion
 *（重力 / 边缘反弹 / 地面摩擦 / 落地 Q 弹 / 宠物互撞 / 多屏空洞都不变）。
 *
 * 两条约定：
 *   - 方向 = 拉的**反方向**（往左下拉 → 往右上弹），见 pullAngle；
 *   - 力度**不设上限**：既不过 softClampSpeed，也不夹 power。软钳速是为手速抖动设的，
 *     拉得远和拉得更远必须能区分开——那正是「按距离给力度」的意义。
 * 刻度与 throwVelocity 同源：power = 1 对应 THROW_SPEED_ANCHOR，并乘同一个
 * physics.throwPower（设置页「总力度」，与拖拽甩抛共用一份配置）。
 */
export declare const SLINGSHOT_REF_RATIO = 0.6;
/** 「一倍力度」的拉距（px）：随宠物尺寸缩放——小宠物不必拖同样远才炸 */
export declare const slingshotRefDist: (size: number) => number;
/** 拉距 → 力度倍率（px / 参考拉距）：线性、单调、**不夹取**；0 拉距 = 0 力度 */
export declare const slingshotPower: (dist: number, size: number) => number;
/**
 * 拉向量（起点 → 松手点，屏幕坐标，y 向下）→ 弹射角度（度，0 = 正右、逆时针为正）。
 * 弹的是拉的**反方向**：往左拉 → 正右飞出；往上拉 → 向下落。角度约定与 throwVelocity 同一套。
 */
export declare const pullAngle: (pullX: number, pullY: number) => number;
/** 弹弓初速：角度约定、力度锚点与 throwVelocity 相同，但**没有软上限**（任意 power 都单调可区分） */
export declare const slingshotVelocity: (angleDeg: number, power: number, throwPower?: number) => {
    vx: number;
    vy: number;
};
/**
 * 由拖拽轨迹估算松手初速 (vx, vy)，px/s。
 * 方向：窗口首末端点位移方向（抗抖）。大小：端点平均与峰值按 PEAK_WEIGHT 加权，
 * 末段仍在加速时按 ACCEL_REF 比例增益（最多 ACCEL_GAIN_MAX），软钳速封顶。
 * 总力度：软钳速**之后**整体 ×physics.throwPower —— 初速、软上限（3600×p）、
 * 死区判定（相对力度）三者一体线性缩放（p=1 即现状）。
 * 返回 null = 温柔放下（轨迹为空 / 停留过久 / 窗口太短 / 峰值速度低于死区），调用方不抛。
 */
export declare const estimateReleaseVelocity: (trail: DragSample[], now: number, physics?: PhysicsParams) => {
    vx: number;
    vy: number;
} | null;
/**
 * 抛体单步积分 + 边界反弹。返回更新后的状态与两个标志：
 * bounced = 本步是否碰边/落地；atRest = 贴地且低速（或碰边后整体低速），调用方应停止循环。
 * physics = 配置成品的抛掷物理参数（重力/弹性/地面摩擦/顶部反弹）；缺失时用默认值兜底。
 */
export declare const throwStep: (s: ThrowState, dtRaw: number, b: ThrowBounds, physics?: PhysicsParams) => ThrowState & {
    bounced: boolean;
    atRest: boolean;
};
/**
 * 多屏抛掷步进：与 throwStep 同一套物理，唯一区别是**边界取自「身体中心所在屏」而不是整个桌面**，
 * 且越界后多问一句「越出去的那一侧到底有没有屏」。
 *
 * 越界条件与 throwStep 逐字相同（`x < minX` / `x > maxX` / `y < minY` / `y >= maxY`），
 * 命中后探一下越界侧：探测点 = 该边外第一像素 × 身体中心的另一轴坐标。
 *   - 那里有别的屏 ⇒ **原样放行**（不夹不弹），宠物自然跨屏飞行 / 落到下一块屏；
 *   - 那里什么都没有 ⇒ 按该边反弹。这正是外接矩形方案缺的那道墙，宠物再也飞不进空洞。
 *
 * 探测目标与探测点都用**完整面板**（space.panels，含任务栏区）而不是工作区：
 * 任务栏位于上下两块屏的接缝时，两块屏的 workArea 之间会隔一条不属于任何 workArea 的条带，
 * 按 workArea 探测会把它当墙——宠物甩到接缝处就在任务栏上沿反弹，永远穿不过去（且下边界
 * 视觉上停在任务栏上方）。面板包含任务栏条带，跨越接缝自然放行；反弹/休息线仍按工作区
 * （脚不踩任务栏）。探测点 = 当前屏**面板**的边外第一像素：面板底 = 物理屏底，单屏任务栏时
 * 探不到邻屏照常反弹，不会顺着自己面板的条带无限下坠。
 *
 * 关键：放行时**不改位置也不记录「当前屏」**，下一帧照样由身体中心重新定位。
 * 不能改成「越界即切屏」——相邻两屏的 AABB 在缝隙处留有 2×sideAllow 宽的重叠盲区
 * （主屏 maxX = 缝 − size + sideAllow，副屏 minX = 缝 − sideAllow），骑缝的宠物落在盲区里，
 * 切过去会立刻被新屏判为反向越界再切回来，逐帧对跳。无状态判定天然没有这个问题。
 *
 * 与「把屏缝当墙」相反：屏缝两侧都有屏，恒放行——DPI 一致时的跨屏弹跳手感一点不减。
 * 单块屏时探测点恒无邻屏、恒反弹，与 throwStep 逐位一致（有单测钉住）。
 *
 * lockScreen ≥ 0 = **锁定在该屏**（配置根字段 confineToScreen 开启时由桌面端传入）：边界恒取
 * space.bounds[lockScreen]，两条轴的邻屏探测一律跳过——屏缝与空洞一样当墙，甩出去只在本屏内弹、
 * 不会飞到隔壁显示器。浏览器 overlay 只有一块屏（视口），该开关在那里天然无效果。
 * 索引越界（飞行途中拔掉显示器导致屏数变少）即退回不锁定，免得拿一块不存在的屏当边界。
 */
export declare const throwStepRegion: (s: ThrowState, dtRaw: number, space: ThrowSpace, physics?: PhysicsParams, lockScreen?: number) => ThrowState & {
    screen: number;
    bounced: boolean;
    atRest: boolean;
};
/** 单步允许的最大位移（px）：一帧位移超过它就拆成多步积分 */
export declare const SUBSTEP_PX = 8;
/** 单帧最多拆几步（兜底：极端速度下别把一帧拖成几百次积分） */
export declare const SUBSTEP_MAX = 64;
/**
 * 一帧该积几步（整数 ≥ 1）。**N = 1 是常态**：普通甩抛一帧位移远小于 8px，与旧的单步积分逐位相同；
 * 只有弹弓拉得很远、初速到几千 px/s 时才会拆多步——否则一帧跨过上百 px 会跳过「落地」与「反弹」
 * 那几帧，Q 弹、摩擦、atRest 判定都会漏。
 *
 * dt 先按 MAX_STEP_DT 夹取（与 throwStep 内部的夹取同源），保证步数算的就是实际要积的时间。
 */
export declare const throwSubsteps: (vx: number, vy: number, dt: number) => number;
/** 多宠物碰撞恢复系数：能量损失约 0.5%（e = 0.995，接近完全弹性） */
export declare const PET_BOUNCE_E = 0.995;
/** 一只参与碰撞的宠物：位置（包围盒左上角，px）+ 速度（px/s）+ 宽（px，质量 ∝ size²） */
export interface PetCollider {
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: number;
}
/** 身体包围盒（HIT_BOX 命中框比例换算到视口像素）：碰撞相交检测的几何。
 *  box = 宠物包围盒左上角（浏览器 root 的 left/top、桌面窗口 pos）；
 *  bottomPad = 舞台脚底垫高（stage 被 translateY 下移的量）。 */
export declare const bodyPixelBox: (o: {
    x: number;
    y: number;
    size: number;
    bottomPad: number;
}) => {
    left: number;
    top: number;
    right: number;
    bottom: number;
};
/** 两矩形是否相交（碰撞检测） */
export declare const rectsOverlap: (a: {
    left: number;
    top: number;
    right: number;
    bottom: number;
}, b: {
    left: number;
    top: number;
    right: number;
    bottom: number;
}) => boolean;
/** 两只宠物碰撞（近乎弹性：动量守恒 + 恢复系数 PET_BOUNCE_E=0.995）。
 * 质量 ∝ size²；碰撞法向 = 两包围盒中心连线方向；
 * 法向速度分量按一维动量公式重分配，切向分量各自保留（无切向摩擦，切向能量无损）。
 * 返回 null = 中心重合无法定法向 / 正在分离（vrel ≤ 0，避免重复弹跳抖动）。
 */
export declare const collidePet: (fly: PetCollider, hit: PetCollider) => {
    fvx: number;
    fvy: number;
    hvx: number;
    hvy: number;
} | null;
/** 共享碰撞站场的槽位（每只宠物注册一个；浏览器 PetMulti 的 arena / 桌面 host broker 共用） */
export interface PetCollisionSlot {
    /** 宠物宽（px，质量 ∝ size²） */
    size: number;
    /** 舞台脚底垫高（bodyPixelBox 需要） */
    bottomPad: number;
    /** 当前包围盒左上角（px）；null = 未挂载/无位置 */
    getBox: () => {
        x: number;
        y: number;
    } | null;
    /** 当前速度（px/s）；非飞行中 = 0 */
    getVel: () => {
        vx: number;
        vy: number;
    };
    /** 被撞回调：用新初速从当前落点开始抛掷（内部复用 startThrow） */
    onHit: (vx: number, vy: number) => void;
}
