// profiler — core/storage.ts
// 持久化抽象。core 默认内存实现（开箱即用）；宿主可注入平台实现，core 不绑任何平台。

/** 勾选状态持久化适配器。宿主注入平台实现。 */
export interface StorageAdapter {
    /** 读取；无值返回空串。 */
    load(key: string): string;
    /** 写入。 */
    save(key: string, value: string): void;
}

/** 默认内存实现：开箱即用、不依赖任何平台（进程内有效，不跨会话）。 */
export class MemoryStorage implements StorageAdapter {
    private _map = new Map<string, string>();

    public load(key: string): string {
        const v = this._map.get(key);
        if (v === undefined) return '';
        return v;
    }

    public save(key: string, value: string): void {
        this._map.set(key, value);
    }
}
