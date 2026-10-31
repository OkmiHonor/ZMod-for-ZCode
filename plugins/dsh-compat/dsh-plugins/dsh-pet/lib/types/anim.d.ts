/**
 * 播放动画（`POST /dsh-pet-7340/anim`）的**纯决策层**。
 *
 * 用途：宿主侧其他插件想让桌宠播一段动画（"点播"），效果与右键菜单里点「动作」树完全一致
 * ——两端都复用同一个菜单动作处理函数，本模块只负责**判定该不该播、播哪一个**。
 *
 * 两种形态（issue #122 第 1 条）：`name` = 池内的动画名，**名字必须在菜单能点到的集合里**；
 * `url` = 第三方自带的素材地址，**不查池**（素材在别人手里）。两者二选一，由本模块判定。
 *
 * 为什么单独一层：契约就是这几条校验规则。播放端对不存在的动画没有兜底（名字即文件名，
 * 404 → 加载失败 → 表现为"点了没反应"），所以名字校验是硬要求，且必须能脱离 HTTP 单测。
 * 本模块只依赖配置（动画池都在 animations 里，不碰文件系统），可完全离线测。
 *
 * 允许集合 = 右键菜单三级树叶里所有 `anim` 的并集。菜单树的唯一事实来源是
 * src/shared/menu.ts 的 buildMenuTree()，它取这 7 个池：idle / turn / drag / clicks /
 * moves.actions / categories / events。
 * **host 不 import src/shared**（DSH 单文件加载约束，见 index.ts 顶部说明），所以这里按同一
 * 口径自包含实现一份；两边的守卫测试会同时钉住这份口径，任一侧改了池子就会有一边失败。
 */
/** 点播失败的分类（路由原样透出给调用方） */
export type AnimFailure = 'bad-request' | 'pet-required' | 'unknown-pet' | 'unknown-animation';
/**
 * 朝向：`left` = 素材原样，`right` = 镜像（渲染端贴 `scaleX(-1)`）。
 * **与 shared/state.ts 的同名联合体是两份**——宿主不 import src/shared（同 `Corner`、`PositionMode`
 * 的处理方式），改动时两边要一起改。
 */
export type PetFacing = 'left' | 'right';
/** 决策结论：通过则给出最终要写进 S 的内容（`name` 与 `url` **恰好一个**），否则给出显式原因。
 *  `facing` **可选**：undefined = 调用方没指定，渲染端**不动朝向**（不是"回落 left"）。 */
export type AnimDecision = {
    ok: true;
    petId: string;
    name?: string;
    url?: string;
    facing?: PetFacing;
} | {
    ok: false;
    reason: AnimFailure;
    message: string;
};
/**
 * 该条目的 animations 配置 → 可点播的动画名（去重，保持首次出现顺序）。
 * 池子与顺序对齐 src/shared/menu.ts 的 buildMenuTree()：
 *   待机 → 转向 → 拖拽 → 点击回应 → 移动 → config 随机动作分类 → 事件（数组槽位展平）
 */
export declare function animationNames(animations: unknown): string[];
/**
 * 第三方资源地址规范化：只放行 **http / https 的完整 URL**，其余一律 null（调用方回 bad-request）。
 *
 * 为什么只放行这两种 scheme：桌面端换源是 `el.src = url` **直连**（不经 `/thumb`），`file:` 会让
 * 渲染端能读本地任意文件；`javascript:` / `data:` 更没有理由开这个口。
 *
 * **跨域不在这里解决、也不该在这里解决**：浏览器端素材走 `fetch` + blob，CORS 由浏览器强制，
 * 插件在 JS 里绕不过去。第三方只有两条路——自己配 `Access-Control-Allow-Origin`，或在同一个
 * DSH webServer 上注册自己的路由（同源，天然无 CORS）。宿主**不做代理**，因此也没有 SSRF 面。
 *
 * 与 ./broadcast 共用这一条规则（两个"第三方投喂"端点的 url 参数是同一条口径，不各写一份）。
 */
export declare function normalizeHttpUrl(v: unknown): string | null;
/**
 * 把外部给的点播请求与当前配置核对成一个结论。
 *
 * `name` 与 `url` **二选一**（issue #122 第 1 条的"资源注册"）：`url` 是第三方自带的素材地址，
 * 给了它就不查动画池——素材在别人手里，池里当然没有这个名字；`name` 照旧必须是池内的名字。
 * 两个都给 / 都不给都是**意图不明**，直接 bad-request，不替调用方猜一个。
 *
 * @param cfg readAllConfig 的合并成品（所有字段已填满，这里不做兜底解析）
 * @param requested `?pet=` 的原值（**必填**：空串 → `pet-required`）
 * @param name 外部给的动画名（未规范化）
 * @param url 外部给的素材地址（未规范化）
 * @param facing 外部给的朝向（**可选**：没给 → 渲染端不动朝向）
 */
export declare function decideAnim(args: {
    cfg: Record<string, Record<string, unknown>>;
    requested: string;
    name: unknown;
    url: unknown;
    facing?: unknown;
}): AnimDecision;
