// profiler — cocos/cocos-profiler.ts
// Cocos 适配层装配：director hook 采集引擎指标 + 驱动 core 采样 + 面板刷新 + 平台存储注入。
// 业务层通过 showProfiler / hideProfiler 进出，不直接碰 core 渲染细节。

import { director, DirectorEvent, gfx } from 'cc';
import { profiler } from '../core/registry';
import { ProfilerPanel } from './panel';
import { LocalStorageAdapter } from './local-storage';

const { deviceManager } = gfx;
const REFRESH_MS = 500;   // 面板文本刷新 / fps 统计窗口
const MB = 1024 * 1024;

/** 引擎指标采集 + 驱动 + 面板。耗时类指标靠 director hook 间时间差，闭包喂给 core。 */
class ProfilerCocos {
    private _panel = new ProfilerPanel();
    private _device: gfx.Device = null;
    private _hooked = false;
    private _storageReady = false;
    private _metricsReady = false;
    private _last = 0;

    // 各阶段耗时（每帧 hook 更新）；引擎读数（每帧读 device 字段）
    private _t = { frame: 0, logic: 0, physics: 0, render: 0, present: 0 };
    private _mark = { frame: 0, logic: 0, physics: 0, render: 0, present: 0 };
    private _stat = { draws: 0, instances: 0, tris: 0, texMB: 0, bufMB: 0 };
    private _frames = 0;
    private _fpsStart = 0;
    private _fps = 0;

    public show(): void {
        if (this._panel.isShowing()) return;
        this.ensureSetup();
        this._device = deviceManager.gfxDevice;
        this._fpsStart = performance.now();
        this._last = this._fpsStart;
        this._panel.show();
        this._hook();
        profiler.markShowing(true);
    }

    public hide(): void {
        if (!this._panel.isShowing()) return;
        this._unhook();
        this._panel.hide();
        this._device = null;
        profiler.markShowing(false);
    }

    public isShowing(): boolean {
        return this._panel.isShowing();
    }

    // 存储 / 指标注册各只做一次（show 可多次开关，注册幂等）

    /** 只装配（存储注入 + 引擎指标注册），不显示面板。GM 构建勾选列表前调，幂等。 */
    public ensureSetup(): void {
        this._ensureStorage();
        this._ensureMetrics();
    }

    private _ensureStorage(): void {
        if (this._storageReady) return;
        profiler.setStorage(new LocalStorageAdapter());
        this._storageReady = true;
    }

    private _ensureMetrics(): void {
        if (this._metricsReady) return;
        this._registerCocosMetrics();
        this._metricsReady = true;
    }

    /** 注册 11 项 Cocos 引擎标准指标。耗时类 get() 闭包读本类每帧测得的值。 */
    private _registerCocosMetrics(): void {
        const t = this._t;
        const stat = this._stat;
        const int = (v: number): string => Math.round(v).toString();
        const mb = (v: number): string => v.toFixed(1);
        profiler.register({ id: 'fps', label: '帧率', get: () => this._fps, warn: (v) => v < 30, format: int, order: 1 });
        profiler.register({ id: 'frame', label: '帧耗时(ms)', get: () => t.frame, average: REFRESH_MS, warn: (v) => v > 33, order: 2 });
        profiler.register({ id: 'logic', label: '逻辑耗时(ms)', get: () => t.logic, average: REFRESH_MS, order: 3 });
        profiler.register({ id: 'physics', label: '物理耗时(ms)', get: () => t.physics, average: REFRESH_MS, order: 4, defaultEnabled: false });
        profiler.register({ id: 'render', label: '渲染耗时(ms)', get: () => t.render, average: REFRESH_MS, order: 5 });
        profiler.register({ id: 'present', label: '提交耗时(ms)', get: () => t.present, average: REFRESH_MS, order: 6 });
        profiler.register({ id: 'draws', label: '绘制调用', get: () => stat.draws, average: REFRESH_MS, format: int, order: 7 });
        profiler.register({ id: 'instances', label: '实例数', get: () => stat.instances, average: REFRESH_MS, format: int, order: 8, defaultEnabled: false });
        profiler.register({ id: 'tricount', label: '三角面数', get: () => stat.tris, average: REFRESH_MS, format: int, order: 9 });
        profiler.register({ id: 'textureMemory', label: '纹理显存(M)', get: () => stat.texMB, format: mb, order: 10 });
        profiler.register({ id: 'bufferMemory', label: '缓冲显存(M)', get: () => stat.bufMB, format: mb, order: 11 });
    }

    private _hook(): void {
        if (this._hooked) return;
        director.on(DirectorEvent.BEFORE_UPDATE, this._beforeUpdate, this);
        director.on(DirectorEvent.AFTER_UPDATE, this._afterUpdate, this);
        director.on(DirectorEvent.BEFORE_PHYSICS, this._beforePhysics, this);
        director.on(DirectorEvent.AFTER_PHYSICS, this._afterPhysics, this);
        director.on(DirectorEvent.BEFORE_DRAW, this._beforeDraw, this);
        director.on(DirectorEvent.AFTER_RENDER, this._afterRender, this);
        director.on(DirectorEvent.AFTER_DRAW, this._afterPresent, this);
        this._hooked = true;
    }

    private _unhook(): void {
        if (!this._hooked) return;
        director.off(DirectorEvent.BEFORE_UPDATE, this._beforeUpdate, this);
        director.off(DirectorEvent.AFTER_UPDATE, this._afterUpdate, this);
        director.off(DirectorEvent.BEFORE_PHYSICS, this._beforePhysics, this);
        director.off(DirectorEvent.AFTER_PHYSICS, this._afterPhysics, this);
        director.off(DirectorEvent.BEFORE_DRAW, this._beforeDraw, this);
        director.off(DirectorEvent.AFTER_RENDER, this._afterRender, this);
        director.off(DirectorEvent.AFTER_DRAW, this._afterPresent, this);
        this._hooked = false;
    }

    private _beforeUpdate(): void {
        const now = performance.now();
        this._mark.frame = now;
        this._mark.logic = now;
    }

    private _afterUpdate(): void {
        const now = performance.now();
        if (director.isPaused()) {
            this._mark.frame = now;   // 暂停：重置 frame 起点，不计入帧耗时
            return;
        }
        this._t.logic = now - this._mark.logic;
    }

    private _beforePhysics(): void {
        this._mark.physics = performance.now();
    }

    private _afterPhysics(): void {
        this._t.physics = performance.now() - this._mark.physics;
    }

    private _beforeDraw(): void {
        this._mark.render = performance.now();
    }

    private _afterRender(): void {
        const now = performance.now();
        this._t.render = now - this._mark.render;
        this._mark.present = now;
    }

    private _afterPresent(): void {
        const now = performance.now();
        this._t.frame = now - this._mark.frame;
        this._t.present = now - this._mark.present;

        this._frames += 1;
        const elapsed = now - this._fpsStart;
        if (elapsed >= REFRESH_MS) {
            this._fps = this._frames * 1000 / elapsed;
            this._frames = 0;
            this._fpsStart = now;
        }

        this._readDevice();
        profiler.sample(now);   // 每帧累积（averager 平均窗口靠这个）

        if (now - this._last < REFRESH_MS) return;
        this._last = now;
        this._panel.render(profiler.snapshot());   // 降频刷新文本，避免每帧重排 RichText
    }

    private _readDevice(): void {
        const d = this._device;
        if (!d) return;
        this._stat.draws = d.numDrawCalls;
        this._stat.instances = d.numInstances;
        this._stat.tris = d.numTris;
        this._stat.texMB = d.memoryStatus.textureSize / MB;
        this._stat.bufMB = d.memoryStatus.bufferSize / MB;
    }
}

/** 全局单例：业务接入层 import 同一个。 */
export const profilerCocos = new ProfilerCocos();

/** 显示性能面板（自建独立渲染层，无需宿主传节点）。 */
export function showProfiler(): void {
    profilerCocos.show();
}

/** 隐藏性能面板。 */
export function hideProfiler(): void {
    profilerCocos.hide();
}

/** 只装配（存储 + 引擎指标），不显示面板。供 GM 构建勾选列表时调，幂等。 */
export function ensureEngineMetrics(): void {
    profilerCocos.ensureSetup();
}

let _toolbarBound = false;

/**
 * 联动 Cocos Creator 预览页 toolbar 的 "Show FPS" 按钮（#btn-show-fps，源自
 * builtin/preview/static/views/toolbar.ejs）：按下显示本面板，再按隐藏。
 * 仅在浏览器预览环境生效；非浏览器（jsb/native）或按钮不存在时静默跳过。幂等。
 */
export function bindPreviewToolbarToggle(): void {
    if (_toolbarBound) return;
    if (typeof document === 'undefined') return;
    const btn = document.getElementById('btn-show-fps');
    if (!btn) return;
    _toolbarBound = true;

    let showing = btn.classList.contains('checked');
    if (showing) showProfiler();
    btn.addEventListener('click', () => {
        showing = !showing;
        if (showing) showProfiler();
        else hideProfiler();
    });
}
