/**
 * 第三方右键菜单注册表（进程内存态，DSH 重启即清空；不落盘）。
 *
 * 用途：别的插件想在桌宠右键菜单里加自己的入口，就走这里注册；用户点了之后，注册方用它自己的
 * owner 去查"我这一项被点了没有、是哪只宠物上点的"。
 *
 * 数据形状（两层，没有第三层）：
 *
 *   owners: Map<owner, Map<label, petId | null>>
 *           键 = owner（身份键，同时也是一级分组名）
 *           值 = label → 触发它的宠物 id；null = 没点过
 *
 * 语义要点（实现前先读完，都是刻意的）：
 *  - **注册 = 整体覆盖**：该 owner 的菜单项 = 本次 labels 事件（不在列表里的项连同触发标记一起
 *    丢弃）。没有单独的删除接口——注销就再注册一个空列表？不，空列表按非法处理（400），
 *    所以"不想要了"只能注册一份新的（或等进程重启）。这是有意的：菜单项生命周期与插件一致。
 *  - **同 owner 内 label 唯一**：重复 label 去重（保留第一次出现的顺序）。
 *  - **点击是闩锁不是队列**：同一项连点两次，查询只看到"点过"一次；不计数、不排序。
 *  - **查询即清空**（读取即消费）：返回后把这些标记全部清成 null。没有确认、没有重投——
 *    查询方没处理完就崩了，这次触发就丢了（对"用户点了一下菜单"这种一次性触发是合理取舍）。
 *  - **一个 owner 只该有一个消费者**：两个进程同时查会互抢（谁先返回谁拿到标记）。
 *
 * 限额（防本机进程把菜单/内存刷爆）：
 *  - owner ≤ 64 字符、label ≤ 32 字符（都允许中文，trim 后非空，禁控制字符）
 *  - 每 owner ≤ 20 项、全局 ≤ 32 个 owner
 */
/** 长轮询等待上限（与 /state 同一量级：调用方一次最多挂这么久） */
export declare const MENU_WAIT_MAX_MS = 10000;
/** 一条菜单项快照（写进 /state 的 sections.menu，两端据此拼「更多」） */
export interface MenuItemSnapshot {
    owner: string;
    label: string;
}
/** 注册结果：业务失败按插件口径回 `{ ok:false, reason, message }`（HTTP 200），不是 400 */
export type MenuRegisterResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
    message: string;
};
export declare class MenuRegistry {
    /** owner → (label → 触发它的 petId；null = 未触发) */
    private readonly owners;
    /** owner → 挂在该 owner 上的长轮询唤醒回调 */
    private readonly waiters;
    constructor();
    /**
     * 注册（整体覆盖）：`{ owner, labels: string[] }`。
     *
     * 覆盖的粒度是 **owner 的全部菜单项**，不是逐项 upsert：这样注册方每次都能用一份完整列表
     * 描述"我现在有什么"，不必关心上次注册了什么，也不会留下已下线的僵尸项。
     */
    register(raw: unknown): MenuRegisterResult;
    /**
     * 清掉一个 owner 的全部菜单项（连它上面未取走的触发标记一起丢）。
     *
     * 幂等：owner 本来就不存在 → `removed: 0`，仍算成功——调用方重试注销时不该看到错误。
     * 挂在该 owner 上的长轮询会被叫醒，醒来后查不到 owner → `null`（路由回 `ok:false` +
     * `unknown-owner`），调用方据此知道要重新注册。
     */
    clear(rawOwner: unknown): {
        ok: true;
        removed: number;
    } | {
        ok: false;
        reason: string;
        message: string;
    };
    /** 全量快照（写进 state；顺序 = 注册顺序 + 列表顺序，两端渲染顺序与它一致） */
    snapshot(): MenuItemSnapshot[];
    /**
     * 渲染端上报一次点击：把该项标成"被 petId 点了"，并叫醒该 owner 上挂着的长轮询。
     *
     * `delivered = false`（项不存在：菜单刚好被覆盖/还没注册）**不算错误**——渲染端拿着的是
     * 上一拍 /state 的快照，这一拍菜单已经变了，属于正常竞态，路由仍回 200。
     */
    click(raw: unknown): {
        ok: true;
        delivered: boolean;
    };
    /**
     * 查询触发：返回 `{ label: petId | null }` 全量映射，**返回即清空**这些标记。
     *
     * `waitMs > 0` 且当下没有任何触发 → 挂起等待（该 owner 被点/超时/被覆盖都会唤醒），
     * 超时后照常返回全 null 的映射。owner 不存在 → null（路由回 404，调用方据此知道要重新注册）。
     */
    poll(owner: string, waitMs: number): Promise<Record<string, string | null> | null>;
}
