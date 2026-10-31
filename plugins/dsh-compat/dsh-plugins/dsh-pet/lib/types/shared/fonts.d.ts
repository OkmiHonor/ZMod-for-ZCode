import type { FontConfig, FontFamilyId } from './types';
/** 一个字体预设：id（写进 config.jsonc 的 font.family）+ 两端共用的 CSS 字体栈 */
export interface FontPreset {
    id: FontFamilyId;
    /** CSS font-family 的值（不含尾部分号）：系统字体名跨平台写法用逗号并列兜底，末位必须是通用族 */
    stack: string;
}
/** 字体预设清单：顺序 = 设置页下拉框的显示顺序（第一项是默认）。
 *  candy 是唯一随包发布的字体（assets/fonts/上首软糖体.ttf），两端各自注入 @font-face 后即可用；
 *  它的 CSS 名 "ShangshouSoftCandy" 是**我们自己起的**（与字体文件内部名称无关），改名要同步
 *  浏览器端 bubble.ts 与桌面端 renderer.js 的 @font-face 声明。
 *  其余都是系统字体：机器上没装时由后面的兜底自然回退，不报错也不空白。 */
export declare const FONT_PRESETS: FontPreset[];
/** 字号合法区间（px，含端点）：与 host 侧 fontValid 的边界同一份口径
 *  （设置页据此即时提示，host 据此事后拦截手改的配置文件） */
export declare const FONT_SIZE_MIN = 4;
export declare const FONT_SIZE_MAX = 200;
/** font 段默认值：与内置 assets/config.jsonc 的 font 段一致。
 *  刻意等于「接入本配置之前的行为」——462 宽宠物气泡 21px、且随宠物大小缩放，
 *  所以不含 font 字段的旧配置，渲染结果与改造前一致。 */
export declare const DEFAULT_FONT: FontConfig;
/** 按 id 取字体栈（id 非法/缺失 → 回退清单首项 = 软糖体）：渲染层零兜底逻辑，一律经此取 */
export declare function fontStackOf(id: string): string;
/** 基准宠物宽度（px）：字号换算的锚点——与内置 config.jsonc 的默认宠物 size 一致，
 *  也是既有 CSS 系数（气泡 0.0455、提示 0.026）当初的设计基准。 */
export declare const FONT_REF_SIZE = 462;
/** 基准宽度下的气泡正文字号（px）＝ 0.0455 × 462 ≈ 21.02（= 接入 font 配置前 462 宽宠物的气泡字号） */
export declare const BUBBLE_FONT_BASE_PX: number;
/** 基准宽度下的悬浮提示字号（px）＝ 0.026 × 462 ≈ 12.01（同上，改造前的取值） */
export declare const TIP_FONT_BASE_PX: number;
/** 气泡与悬浮提示的**最终字号**（px）——两端共用同一份换算，避免浏览器与桌面各算一套后漂移。
 *
 *  口径（以 462 宽为锚；CSS 只读算好的像素值，不在 CSS 里做除法）：
 *    字号 = 基准px × (font.size ÷ 默认字号) × (followPet ? 宠物宽度 ÷ 462 : 1)
 *  - 默认值（size=21 / followPet=true）在 462 宽宠物上得到 21.02px 与 12.01px —— 与接入本配置前一致；
 *  - followPet=false 退化为「固定在 462 宽时的字号」，与宠物大小解耦；
 *  - 配置被手改坏（字号非正 / 宽度非法）时按默认口径处理，绝不产出 NaN 或 0 字号。
 *
 *  @param font 该宠物的 font 配置（拍平时已吹入；缺失按 DEFAULT_FONT）
 *  @param size 该宠物的宽度 px */
export declare function resolveFontPx(font: FontConfig | undefined, size: number): {
    bubble: number;
    tip: number;
};
/** 气泡底边探出宠物盒顶边的比例：对应气泡 CSS 的 `bottom:calc(100% - var(--dsh-pet-size)*0.108)`。
 *  探出的这一段同样算进「气泡可用的垂直空间」，见下面的 bubbleTopMarginPx。 */
export declare const BUBBLE_OVERLAP_RATIO = 0.108;
/** 气泡布局度量（em 语义，基准 = 气泡正文最终字号 `--f`）。系数与渲染层 CSS **同源**：
 *  bubble.ts / index.html 的 `.dsh-pet-bubble`（行高 1.6、内边距 0.4835、次要行 0.7692）与
 *  shared/whisper.ts 的 MEME_BUBBLE_CSS（配图宽 7.4725、下边距 0.3736）。
 *  改任何一条 CSS 系数都必须同步这里，否则桌面窗口的上边距会算少 → 气泡顶端被窗口切掉。 */
export declare const BUBBLE_METRICS: {
    readonly lineHeight: 1.6;
    readonly padY: 0.4835;
    readonly subScale: 0.7692;
    readonly imgWidth: 7.4725;
    readonly imgMargin: 0.3736;
    /** 配图长宽比上限（内置 assets/memes 全为 128 宽、高 ≤ 128，即 ≤ 1.0） */
    readonly imgMaxRatio: 1;
};
/** 气泡最大高度（px）：文本最多两行（余额气泡的「主行 + 次要行」），可带一张配图。
 *  桌面端用它定窗口上边距（见 bubbleTopMarginPx）；浏览器端没有窗口限制，不需要。 */
export declare function bubbleMaxHeightPx(font: FontConfig | undefined, size: number): number;
/** 桌面窗口的**最小上边距**（px）：上边距至少要容得下整只气泡。
 *  气泡底边落在宠物盒顶边下方 `0.108 × 宠物尺寸` 处，所以余量 = 气泡最大高度 − 这一段。
 *  默认配置（462px 宠物 / 21px 字号）算出 195px，仍小于既有余量 231px，窗口尺寸不变；
 *  宠物变小而字号固定（关闭 followPet）时才会把窗口向上加高，避免气泡顶端被窗口上边缘切掉。 */
export declare function bubbleTopMarginPx(font: FontConfig | undefined, size: number): number;
