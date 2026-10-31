/**
 * 气泡两个端点（`POST /dsh-pet-7340/broadcast` 与 `POST /dsh-pet-7340/bubble/clear`）的
 * **纯决策层**——两者写的是同一个叶子（`pets.<id>.say`），也共用同一条"pet 落到哪只"的规则，
 * 所以放在一起，免得两处各写一遍走样。
 *
 * 背景（issue #76）：宿主侧其他插件（女仆巡检验等）想说自己的话，需要一个把它们给的文本
 * 放进桌宠气泡的入口。这个端点**不生成**内容，只搬运——和 /whisper（用 LLM 生成）分工不同。
 * `POST /bubble/clear` 是它的反面：收起气泡（issue #122 第 5 条的"提前撤回"）。
 *
 * 为什么单独一层：本功能的契约就是这几条校验规则（文本非空、时长合法、宠物必须真实存在、
 * 配图给名称时须命中包内表情包池、给 url 时须是 http/https 完整地址、两种形态不得同时给），
 * 它们必须能脱离 HTTP 与真实文件系统被单测——路由层
 * （src/host/index.ts）在源码形态下读不到包内 assets，测不了这些分支。
 *
 * 设计口径：
 * - **不设长度限制，也不限频**：投喂是显式的调用方行为，内容与频率都由调用方自己负责；
 *   宿主只保证"非空就搬运"，不做静默丢弃、截断或排队。
 * - `duration` **不设上限**（调用方自己负责），但必须是 ≥0 的有限数；`0` = 字面意思「不显示」。
 * - `anim` 只有**严格 `false`** 才关闭动画联动（宽松口径：`"false"` 字符串之类一律按"要联动"
 *   走）。关闭时消费端不查 `events.whisper` 池、不换源。
 * - 配图两种形态二选一：`image` 只认**该桌宠条目表情包池内**的名称（池内命中即取其规范名，
 *   与对话选图共用同一份 matchMeme 校验）；`url` 是第三方自带的完整地址，**不查池**
 *   （issue #122 第 1 条：素材由第三方自己托管）。给了 url 就等于调用方显式选择了外部地址，
 *   不再是"注入"——但 scheme 仍由宿主卡在 http/https。
 * - 失败一律返回明确 reason，不抛异常（路由据此回 HTTP 200 + ok:false，与 /chat 口径一致）。
 * - memeDirs 是参数而非模块常量：池的目录链由调用方（host/index.ts 的 memeDirsFor）唯一决定，
 *   便于测试注入临时目录（同 memes.ts 的约定）。
 */
/** pet 参数解析失败的两种分类（三个"pet 必填"端点共用这一对词汇，与 ./anim、./motion-cue 同口径） */
export type PetFailure = 'pet-required' | 'unknown-pet';
/** 投喂失败的分类（路由原样透出给调用方） */
export type BroadcastFailure = 'bad-request' | PetFailure | 'unknown-image';
/** 决策结论：通过则给出最终要写进 S 的内容，否则给出显式原因。
 *  `image` 与 `url` **最多一个**（配图两种形态，由字段名区分，见 shared/state.ts 的 SayCue）。
 *  `duration` / `anim` 是**已解析**的生效值（缺省也已填成显式值），路由原样写进叶子。 */
export type BroadcastDecision = {
    ok: true;
    petId: string;
    text: string;
    image?: string;
    url?: string;
    duration: number;
    anim: boolean;
} | {
    ok: false;
    reason: BroadcastFailure;
    message: string;
};
/** 清空气泡的决策结论（只有宠物解析这一步会失败） */
export type BubbleClearDecision = {
    ok: true;
    petId: string;
} | {
    ok: false;
    reason: PetFailure;
    message: string;
};
/**
 * 投喂文本规范化：非字符串 / 纯空白 → 空串。
 * 路由与决策层**共用这一条规则**（路由用它先短路掉"空文本"，避免为了一个必然失败的
 * 请求去读配置；两处若各写一遍就会走样）。
 */
export declare function normalizeBroadcastText(text: unknown): string;
/**
 * 气泡时长规范化：缺省 / null → 默认 10s；合法则原样；**非法返回 null**。
 * 同样由路由与决策层共用——路由先短路，别为一个必然失败的请求去碰磁盘。
 * 非法 = 非数字 / 非有限（NaN、Infinity）/ 负数。`0` 是合法值（字面意思：不显示）。
 */
export declare function normalizeBroadcastDuration(duration: unknown): number | null;
/**
 * 动画联动开关规范化：**只有严格 `false` 才关闭**，其余（含缺省、`true`、字符串、数字）
 * 一律按"要联动"处理。
 * 宽松是有意的：老调用方不会传这个字段，宽松口径保证它们的行为一个字都不变。
 */
export declare function normalizeBroadcastAnim(anim: unknown): boolean;
/**
 * 把外部给的 `{ text, image, url, duration, anim }` 与当前配置核对成一个结论。
 *
 * 配图两种形态**二选一**（issue #122 第 1 条的"资源注册"）：`image` = 池内名称（照旧校验），
 * `url` = 第三方自带的完整地址（**不查池**）。两个都给 = 意图不明，回 bad-request。
 *
 * @param cfg readAllConfig 的合并成品（所有字段已填满，这里不做兜底解析）
 * @param requested `?pet=` 的原值（**必填**：空串 → `pet-required`）
 * @param text 外部给的文本（未规范化）
 * @param image 外部给的配图名（未规范化；空/缺省 = 不配图）
 * @param url 外部给的配图地址（未规范化；空/缺省 = 不配图）
 * @param duration **已规范化**的时长（见 normalizeBroadcastDuration；路由保证非 null）
 * @param anim **已规范化**的联动开关（见 normalizeBroadcastAnim）
 * @param memeDirs 条目（素材根）→ 表情包目录链（顺序即优先级）；决定池里哪些图真实存在
 */
export declare function decideBroadcast(args: {
    cfg: Record<string, Record<string, unknown>>;
    /** `?pet=` 的原值（**必填**：空串 → `pet-required`） */
    requested: string;
    text: unknown;
    image: unknown;
    url: unknown;
    duration: number;
    anim: boolean;
    memeDirs: (entry: string) => string[];
}): BroadcastDecision;
/**
 * 清空气泡的决策：只需要确定"清哪只宠物的"。
 *
 * **占用门禁不在这里**：本函数只管"清哪一只"，"谁有资格清"由路由层在它之后过一遍
 * `lockBlocked`（占用期间只有持锁者能清——否则第三方一调就把别人的气泡抹了）。没带 `lock`
 * 时那一步放行，所以本函数的语义与改造前**逐字一致**；带了失效编号则由 `lockBlocked` 拦下。
 *
 * 与 /broadcast 的区别：**没有"气泡不存在"这种失败**。当前没气泡也返回 ok（幂等），
 * 因为"让气泡消失"这个意图在空状态下已经成立了。
 */
export declare function decideBubbleClear(args: {
    cfg: Record<string, Record<string, unknown>>;
    /** `?pet=` 的原值（**必填**：空串 → `pet-required`） */
    requested: string;
}): BubbleClearDecision;
