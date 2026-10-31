/**
 * 某宠物最终生效的人设正文（不含名字与时间）：
 * `pets[].whisperPrompt`（实例级）→ 条目顶层 `whisperPrompt` → 空串。
 *
 * 语义是**替换**而不是拼接：实例写了就完全取代条目那一份。拼接会让两段人设互相打架
 * （条目写「你是蓝发女仆」、实例写「你是黑发猫娘」，模型收到两个身份）。
 *
 * 实例级的值由 host/config.ts 的 mergePet 过滤过（只放行非空字符串），这里仍做一次
 * `trim()` 判空——petPersona 也是导出函数，不能假设调用方一定走了合并器。
 */
export declare function petPersona(conf: Record<string, unknown>, pet: Record<string, unknown>): string;
/** composeSystemPrompt 的入参 */
export interface SystemPromptParts {
    /** 已回落到生效值的人设正文（petPersona 的结果；空串 = 没有人设，只有名字 + 时间） */
    prompt: string;
    /** 显示名（pets[].name；缺失/空按 id 处理） */
    name: string;
    /** 宠物 id（name 为空时的兜底；两者都空 = 整段名字声明省略） */
    id: string;
    /** 生成这一刻（生产传 new Date()，测试传固定日期） */
    now: Date;
}
/**
 * 拼出最终 system 提示词：人设正文 + 名字声明 + 时间背景。
 *
 * 边界：
 *   - prompt 为空 → 不加前导换行（不会产出以 `\n` 开头的提示词）；
 *   - name 与 id 都为空 → 整段名字声明不加（不可能发生：id 是合并器的必填字段）；
 *   - now 非法（NaN）→ timeContextOf 返回空串，整行时间背景不加（宁缺，也不把 NaN 拼进提示词）。
 */
export declare function composeSystemPrompt(parts: SystemPromptParts): string;
