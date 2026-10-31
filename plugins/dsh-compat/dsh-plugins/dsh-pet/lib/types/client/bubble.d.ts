import { type BalanceState } from '../shared/balance';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';
/**
 * 制造余额气泡（工厂）。
 * 工厂内注入样式一次（与 pet.ts 的 injectCss 同模式）；组件为哑组件，props = { state, on, expanded, onToggle }。
 * 内容来自 src/shared 的 balanceBubbleView / balanceDetailView（与桌面模式完全一致）。
 *
 * 两种形态：
 *  - 收起（默认，/balance 与自动轮询出来的就是它）：两行 —— 最紧迫窗口的「已用 N%」+ 重置倒计时；
 *  - 展开（点气泡）：三个窗口各一行 —— 窗口名 + 进度条 + 已用百分比 + 重置倒计时。
 * 切换是淡出 → 换内容 → 淡入，不是硬切。显隐与 10s 计时仍归上层（pet.ts）管，本组件只管内容。
 */
export declare function makeBalanceBubble(rt: {
    h: typeof jsx;
    useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
    useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
}): (props: {
    state: BalanceState;
    on: boolean;
    /** 目标形态（点一下切换） */
    expanded: boolean;
    /** 点击气泡：上层据此切换 expanded 并重置 10s 计时器 */
    onToggle: () => void;
}) => ReactNode;
/**
 * 制造碎碎念气泡（工厂）。
 * 与余额气泡共用同一套样式（dsh-pet-bubble）与行渲染（rowsToNodes）；
 * 内容来自 src/shared 的 whisperBubbleView（与桌面模式完全一致）。
 * image：配图名称（配置 memes 的键），有值则在文字上方渲染该表情包；
 *        图片样式取自 shared 的 MEME_BUBBLE_CSS（两端同一份，这里只声明式建节点）。
 * url：配图的另一种形态（第三方自带的完整地址），**与 image 二选一**（host 判定层保证），
 *        有值就直接当 img.src 用、不再拼表情包路径（issue #122 第 1 条）。
 * assetRoot：**只在 image 形态下有意义**——素材根（= 该宠物的条目 key），决定图片去哪个表情包
 *        目录链取（种类独占 pet/<名>-memes/ → 用户目录 → 包内），与动画素材同一套归属语义。
 */
export declare function makeWhisperBubble(rt: {
    h: typeof jsx;
}): (props: {
    text: string;
    image?: string;
    url?: string;
    assetRoot?: string;
    on: boolean;
}) => ReactNode;
