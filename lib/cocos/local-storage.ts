// profiler — cocos/local-storage.ts
// StorageAdapter 的浏览器实现：直接用 window.localStorage（不依赖任何引擎 / 平台 SDK）。

import { StorageAdapter } from '../core/storage';

/** 用浏览器原生 window.localStorage 持久化勾选。 */
export class LocalStorageAdapter implements StorageAdapter {
    public load(key: string): string {
        const v = window.localStorage.getItem(key);
        if (!v) return '';
        return v;
    }

    public save(key: string, value: string): void {
        window.localStorage.setItem(key, value);
    }
}
