// Copyright (c) cc-profiler contributors
// SPDX-License-Identifier: Apache-2.0
//
// profiler — core/metric.ts
// 纯 TS，零引擎依赖。指标模型 + 平均窗口计数器。

/** 一个监控指标。pull 模型：core 统一靠 get() 取值。 */
export interface Metric {
    /** 唯一 id，用于勾选 / 持久化。 */
    id: string;
    /** 面板显示名。 */
    label: string;
    /** 取值。当场可算的直接返回；耗时类由驱动层测好、闭包读出。 */
    get(): number;
    /** 命中返回 true 即在面板标红。基于展示值（有平均窗口时为均值）判断。 */
    warn?(v: number): boolean;
    /** 数值格式化。缺省两位小数。 */
    format?(v: number): string;
    /** 排序，小在上。缺省 100。 */
    order?: number;
    /** 平均窗口（ms）。设了则显示窗口内均值、抹平抖动；缺省显示瞬时值。 */
    average?: number;
    /** 注册时是否默认启用（缺省 true）。仅当用户从未在 GM/面板上动过本项时生效，动过即以用户选择为准。 */
    defaultEnabled?: boolean;
}

/** snapshot 产出的一行渲染数据。renderer 据此画一行，warn 决定是否标红。 */
export interface Row {
    /** 来源 id（调试用）。 */
    label: string;
    /** 整行文本（可含 \n，文本段可能多行）。 */
    text: string;
    /** 是否标红。 */
    warn: boolean;
}

/** 平均窗口计数器：窗口内累积求均值，超窗口翻篇。 */
export class Averager {
    private _value = 0;
    private _avg = 0;
    private _accum = 0;
    private _samples = 0;
    private _start: number;

    constructor(now: number) {
        this._start = now;
    }

    /** 喂一个采样值。window <= 0 时只记瞬时、不累积。 */
    public push(v: number, now: number, window: number): void {
        this._value = v;
        if (window <= 0) return;
        this._accum += v;
        this._samples += 1;
        if (now - this._start >= window) {
            this._avg = this._samples > 0 ? this._accum / this._samples : v;
            this._accum = 0;
            this._samples = 0;
            this._start = now;
        }
    }

    /** 展示值：有窗口取均值，否则瞬时。 */
    public value(window: number): number {
        return window > 0 ? this._avg : this._value;
    }
}
