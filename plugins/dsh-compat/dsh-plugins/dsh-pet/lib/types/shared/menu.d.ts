import type { Animations, Category, PetDisplay } from './types';
/** 叶子：可点击的菜单项 */
export interface MenuLeaf {
    label: string;
    /** 播放的动画名（点播动作）；action 优先于 anim */
    anim?: string;
    /** 自定义动作：open-site=打开网站 / show-balance=查看余额；whisper=立即碎碎念一句；
     * chat=打开对话弹窗；home=回到初始位置；reload=重载配置（桌面端专属：重启桌面 Helper，
     * 全部桌面宠物窗口按最新配置重建——浏览器端刷新页面即可，不注入此项）；
     * set-display=改这只宠物的显示位置（目标值见 display 字段；**两端都注入**——桌面端拿它把
     * 宠物送走、浏览器端拿它把宠物送到桌面，菜单项统一由 displayMenuBranch() 提供）；
     * third-party=第三方注册的菜单项（见 buildMoreBranch）——点击只把 (owner, label) 上报给宿主，
     * 具体做什么由注册方自己决定。
     * 手动触发均不受 whisperEnabled 影响（该字段只关自动周期轮询） */
    action?: 'open-site' | 'show-balance' | 'whisper' | 'chat' | 'home' | 'reload' | 'set-display' | 'third-party';
    /** set-display 的目标显示位置（与设置页「显示位置」下拉框同一套取值） */
    display?: PetDisplay;
    /** third-party：注册它的 owner（身份键，**只用于回传，不显示**）。同一个 owner 的项收在同一个
     *  分组下；只有一项时跳过这层、直接平铺（见 buildMoreBranch）。 */
    owner?: string;
    /** 项目右侧的灰色小字（如快捷键「Ctrl+左键」）：纯视觉提示，不参与显示文本匹配，也不影响
     *  动作分发。缺省不占位（不显示任何东西）。 */
    hint?: string;
}
/** 分支：带子菜单的项 */
export interface MenuBranch {
    label: string;
    children: MenuNode[];
}
export type MenuNode = MenuLeaf | MenuBranch;
/**
 * 「显示位置」子菜单 —— 桌面端与浏览器端注入**同一份**（文案与设置页「显示位置」下拉框一致）。
 *
 * 为什么必须放 shared：两端各写一份必然漂移（改了一端的文案或取值，另一端没跟上），而这一项在
 * 两端语义完全对称——桌面端用它把宠物"送走"（仅网页），浏览器端用它把宠物"送到桌面"（仅桌面）。
 *
 * 只有「都不」是单向门（两端都不显示，恢复入口是设置页的下拉框）；其余三个值都能从某一端改回来
 * （仅网页→浏览器里还在，仅桌面→桌面上还在，两者→两端都在）。设置页那条路在本菜单出现之前就是
 * 唯一入口，本菜单只是多加了一条更近的路，没有削弱任何既有能力。
 */
export declare const displayMenuBranch: () => MenuBranch;
/** 第三方菜单项（宿主经 /state 的 sections.menu 下发的快照，一条 = 一个可点项）。 */
export interface MenuMoreItem {
    /** 注册方身份；同时也是一级分组名（显示用） */
    owner: string;
    /** 项名（显示用，也是回传给注册方的标识） */
    label: string;
}
/** 第三方菜单项统一收在这个一级菜单下（宿主自己的菜单项不进这里）。 */
export declare const MORE_MENU_LABEL = "\u66F4\u591A";
/**
 * 从 `/state` 的 `sections.menu.data` 里读出第三方菜单项。
 *
 * 两侧（浏览器 / 桌面）共用同一份解析：快照来自网络，字段一律按"可能不存在"处理——
 * 非法条目静默丢弃，绝不让一条坏数据把整个右键菜单搞崩（菜单是高频交互入口）。
 */
export declare function readMenuItems(data: unknown): MenuMoreItem[];
/**
 * 「更多」一级菜单：把第三方菜单项拼成菜单树的一枝；没有第三方项时返回 null（调用方不注入，
 * 菜单里就不会出现一个空的「更多」）。
 *
 * 层级规则就一条：**按项数决定要不要 owner 这一层**——
 *   - 该 owner 只有 1 项 → 直接 `更多 / 弹弓`（跳过分组，少一次点击）；
 *   - 2 项及以上      → `更多 / 小游戏 / 弹弓`、`钓鱼`。
 * 于是某个 owner 从 1 项变成 2 项时，它原来那一项会"缩进"进分组里——这是这条规则必然的副作用，
 * 换来的是只有一个项的插件不必多开一层。
 *
 * 同名不同 owner 的项允许共存（用户看到两个「弹弓」，点了各回各的 owner）：菜单文案由注册方负责，
 * 这里不做任何去重、编号或来源标注。
 */
export declare function buildMoreBranch(items: readonly MenuMoreItem[]): MenuBranch | null;
/**
 * 由合并后的 animations 配置推导菜单树 —— 输出 [{ 动作 → [ 分类 → [ 具体动画 ] ] }]：
 * 一级只有一个「动作」分支；二级 = 分类（待机/转向/拖拽/点击回应/移动 + config 随机动作
 * 分类 + 事件档位）；三级 = 具体动画名。空池/空分类自动省略。
 */
export declare function buildMenuTree(animations: Animations): MenuNode[];
/** 该动画是否属于 noMirror 分类（文字类）：朝右（镜像）时点播前强制朝左，避免文字镜像 */
export declare function isNoMirrorAnimation(categories: Category[], anim: string): boolean;
/** 菜单样式 —— 两端注入同一份（浏览器并入 plugin css；桌面入窗口 head）。
 *  每一级面板是独立的绝对定位盒子（.dsh-pet-menu-column），位置由 JS 内联写入；
 *  面板与面板之间互不嵌套，各自独立滚动。 */
export declare const MENU_CSS: string;
/** mountContextMenu 返回值 */
export interface ContextMenuMount {
    /** 已挂载的根元素（document.body 下） */
    el: HTMLElement;
    /** 关闭并清理（幂等） */
    close: () => void;
}
/**
 * 挂载一个系统风格右键菜单（级联子菜单）到 document.body。
 * 位置为视口坐标（桌面=窗口视口，浏览器=页面视口）——两端一致。
 *
 * 结构：根容器（fixed，零尺寸）下平级挂**每一级独立面板**，绝无嵌套；
 * 面板按触发项屏幕位置贴边定位（右/下边缘自动翻转夹取）。
 * 级联：悬停分支切换/展开子面板；指针整体离开菜单树（root mouseleave）才关闭整棵菜单；
 * 点击项回调后自动关闭、点击菜单外或按 Esc 关闭；超高列表面板内独立滚动。
 *
 * clamp（可选，#41）：菜单允许占用的矩形（视口局部坐标，默认整个视口）。
 * 桌面模式传「窗口 ∩ 工作区」：宠物贴屏幕底/右时窗口外扩余量伸出屏幕，菜单走进
 * 伸出的部分会被 OS 裁掉——约束到该矩形内即可完整显示，**窗口/宠物零移动零闪帧**。
 */
export declare function mountContextMenu(opts: {
    tree: MenuNode[];
    x: number;
    y: number;
    onAction: (leaf: MenuLeaf) => void;
    /** 菜单被关闭（点项/点外/Esc）后的通知：挂载方据此复位自身状态（如桌面可交互标记） */
    onClose?: () => void;
    /** 菜单允许占用的矩形（视口局部坐标）；缺省 = 整个视口（浏览器既有行为） */
    clamp?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
}): ContextMenuMount;
