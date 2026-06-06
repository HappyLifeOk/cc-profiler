// profiler — core/registry.ts
// 注册表内核：注册指标 / 文本段、统一勾选、采样驱动、产出渲染数据。零引擎依赖。

import { Metric, Row, Averager } from './metric';
import { StorageAdapter, MemoryStorage } from './storage';

const DEFAULT_ORDER = 100;
const STATE_KEY = 'profiler-disabled';

/** 注册表条目统一抽象：指标与文本段都归一到 sample + row。 */
interface Entry {
    readonly id: string;
    readonly label: string;
    readonly order: number;
    sample(now: number): void;
    row(): Row;
}

function defaultFormat(v: number): string {
    return (Math.round(v * 100) / 100).toString();
}

/** 结构化指标条目：采样累积平均，产出 "label: value" 一行，按 warn 标红。 */
class MetricEntry implements Entry {
    public readonly id: string;
    public readonly label: string;
    public readonly order: number;
    private _averager: Averager;
    private _window: number;

    constructor(private _metric: Metric, now: number) {
        this.id = _metric.id;
        this.label = _metric.label;
        this.order = _metric.order === undefined ? DEFAULT_ORDER : _metric.order;
        this._window = _metric.average === undefined ? 0 : _metric.average;
        this._averager = new Averager(now);
    }

    public sample(now: number): void {
        this._averager.push(this._metric.get(), now, this._window);
    }

    public row(): Row {
        const v = this._averager.value(this._window);
        const valueText = this._metric.format ? this._metric.format(v) : defaultFormat(v);
        const warn = this._metric.warn ? this._metric.warn(v) : false;
        return { label: this.id, text: `${this._metric.label}: ${valueText}`, warn };
    }
}

/** 文本段条目（逃生舱）：provider 实时产出整段文本，不参与平均、不标红。 */
class RawEntry implements Entry {
    public readonly id: string;
    public readonly label: string;
    public readonly order: number;

    constructor(id: string, private _provider: () => string, order: number) {
        this.id = id;
        this.label = id;
        this.order = order;
    }

    public sample(): void {
        // 文本段在 row() 实时取，无需采样累积。
    }

    public row(): Row {
        return { label: this.id, text: this._provider(), warn: false };
    }
}

/** profiler 内核：宿主无关、引擎无关。注册 → 采样 → 产出 Row[]，勾选态持久化。 */
export class ProfilerRegistry {
    private _entries = new Map<string, Entry>();
    private _disabled = new Set<string>();
    private _storage: StorageAdapter = new MemoryStorage();
    private _showing = false;

    constructor() {
        this._loadState();
    }

    /** 注入平台持久化实现（宿主初始化时调一次）；注入后重载已存勾选。 */
    public setStorage(storage: StorageAdapter): void {
        this._storage = storage;
        this._loadState();
    }

    /** 注册结构化指标。重复 id 覆盖。 */
    public register(metric: Metric): void {
        this._entries.set(metric.id, new MetricEntry(metric, performance.now()));
    }

    /** 注册文本段（复杂业务展示）。order 缺省 100。重复 id 覆盖。 */
    public rawSection(id: string, provider: () => string, order: number = DEFAULT_ORDER): void {
        this._entries.set(id, new RawEntry(id, provider, order));
    }

    /** 列出所有注册项及启用态（GM 面板一个循环生成勾选）。 */
    public list(): Array<{ id: string; label: string; enabled: boolean }> {
        const out: Array<{ id: string; label: string; enabled: boolean }> = [];
        this._sorted().forEach((e) => out.push({ id: e.id, label: e.label, enabled: !this._disabled.has(e.id) }));
        return out;
    }

    /** 开关某项显示；持久化。 */
    public setEnabled(id: string, on: boolean): void {
        if (on) this._disabled.delete(id);
        else this._disabled.add(id);
        this._saveState();
    }

    public isEnabled(id: string): boolean {
        return !this._disabled.has(id);
    }

    public isShowing(): boolean {
        return this._showing;
    }

    /** 渲染层开关面板时同步状态（showStats / hideStats 在 cocos 层，这里只记状态）。 */
    public markShowing(on: boolean): void {
        this._showing = on;
    }

    /** 采样：遍历启用项累积。由驱动层（cocos director hook）降频调。 */
    public sample(now: number): void {
        this._entries.forEach((e) => {
            if (this._disabled.has(e.id)) return;
            e.sample(now);
        });
    }

    /** 产出渲染数据：启用项按 order 排序，跳过空文本。 */
    public snapshot(): Row[] {
        const rows: Row[] = [];
        this._sorted().forEach((e) => {
            if (this._disabled.has(e.id)) return;
            const r = e.row();
            if (r.text) rows.push(r);
        });
        return rows;
    }

    private _sorted(): Entry[] {
        const arr: Entry[] = [];
        this._entries.forEach((e) => arr.push(e));
        arr.sort((a, b) => a.order - b.order);
        return arr;
    }

    private _saveState(): void {
        const ids: string[] = [];
        this._disabled.forEach((id) => ids.push(id));
        this._storage.save(STATE_KEY, JSON.stringify(ids));
    }

    private _loadState(): void {
        const raw = this._storage.load(STATE_KEY);
        if (!raw) return;
        // storage 内容由宿主平台持有、可能被外部改坏 —— 解析失败回退全开，不连累内核构造。
        try {
            const ids = JSON.parse(raw) as string[];
            this._disabled.clear();
            ids.forEach((id) => this._disabled.add(id));
        } catch {
            this._disabled.clear();
        }
    }
}

/** 全局单例：cocos 适配层、业务接入层 import 同一个。 */
export const profiler = new ProfilerRegistry();
