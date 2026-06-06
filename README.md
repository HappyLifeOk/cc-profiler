# profiler — Cocos 运行时性能监控面板

> 注册式、内核引擎无关的 Cocos 性能监控面板库。`core/` 纯 TS 零依赖，渲染层绑 Cocos。

## 特性

- **注册式**：指标 / 文本段运行时注册进来，内核不认识任何具体业务
- **内核引擎无关**：`core/` 纯 TS，可单独用、可接其他渲染层
- **自带引擎指标**：fps / 帧耗时 / 各阶段耗时（逻辑/物理/渲染/提交）/ drawcall / 实例数 / 三角面 / 显存
- **结构化指标**：阈值标红、平均窗口、排序、格式化
- **独立渲染**：运行时挂到场景 Canvas，不依赖宿主 UI 框架，`show()` 无参
- **持久化**：勾选状态存 `localStorage`，可换实现

## 架构

| 层 | 路径 | 依赖 | 职责 |
|---|---|---|---|
| 内核 | `core/` | 零（纯 TS） | 注册表 + metric 模型 + 平均窗口 + `snapshot()` 渲染契约 + StorageAdapter 接口 |
| Cocos 适配 | `cocos/` | `cc` | 面板渲染 + director 采样驱动 + 引擎指标注册 + localStorage 持久化 |

宿主侧只需用 `register` / `rawSection` 把自己的业务指标喂进来（显存、节点数、网络状态…），内核自动纳入勾选 / 持久化 / 渲染。

## 用法

```ts
import { profiler } from './core/registry';
import { showProfiler, hideProfiler } from './cocos/cocos-profiler';

// 结构化指标
profiler.register({
    id: 'fps', label: '帧率',
    get: () => currentFps,
    warn: v => v < 30,        // 低于 30 标红
    format: v => v.toFixed(0),
    average: 500,             // 500ms 平均窗口
});

// 自定义文本段（复杂展示逃生舱）
profiler.rawSection('net', () => `网络: ${connected ? '已连接' : '断开'}`);

showProfiler();   // 显示面板（自建挂载，无需传节点）
hideProfiler();
```

## core API

```ts
interface Metric {
    id: string;
    label: string;
    get(): number;                 // pull 模型：core 统一靠 get() 取值
    warn?(v: number): boolean;     // 命中即标红
    format?(v: number): string;    // 缺省两位小数
    order?: number;                // 排序，小在上
    average?: number;              // 平均窗口 ms，缺省瞬时
}
profiler.register(m: Metric): void;
profiler.rawSection(id, provider: () => string, order?): void;
profiler.list(): Array<{ id, label, enabled }>;   // 列出所有项 + 启用态（生成勾选用）
profiler.setEnabled(id, on): void;
profiler.isEnabled(id): boolean;
profiler.isShowing(): boolean;
profiler.sample(now): void;        // 采样驱动：core 被动，由采集层降频调
profiler.snapshot(): Row[];        // 渲染契约：core 产出 {label,text,warn}，renderer 消费
profiler.setStorage(s: StorageAdapter): void;   // 持久化注入，core 默认内存实现
```

设计要点：
- **pull 模型统一两类指标**：当场可算的 `get()` 直接返回；推送型耗时（各阶段时间差）由采集层测好存变量，`get = () => thatVar` 闭包桥接——core 永远只认 `get()`。
- **平均窗口归 core**：`sample()` 按 `average` 累积，`snapshot()` 输出均值。
- **warn 标红**：snapshot 每行带 warn 标志，渲染层用 RichText color 标签标红。

## 目录

```text
profiler/
├── core/                  # 纯 TS，零引擎依赖
│   ├── registry.ts       # 注册表 + list/setEnabled/sample/snapshot + 单例 profiler
│   ├── metric.ts         # Metric / Row 接口 + Averager 平均窗口
│   └── storage.ts        # StorageAdapter 接口 + MemoryStorage 默认实现
├── cocos/                 # Cocos 适配
│   ├── cocos-profiler.ts # 装配：director hook 采集 + 驱动 + 引擎指标 + show/hide
│   ├── panel.ts          # 面板渲染（场景 Canvas 子节点 + RichText）
│   └── local-storage.ts  # StorageAdapter 的 window.localStorage 实现
└── README.md
```

## 扩展点

- **换持久化**：实现 `StorageAdapter`（load/save）+ `profiler.setStorage()`。默认 `window.localStorage`，换平台只改这一个文件。
- **换渲染层**：core 的 `snapshot(): Row[]` 是渲染契约，另写一个消费 `Row[]` 的 renderer 即可脱离 Cocos。
- **加业务指标**：`register` / `rawSection` 注册，内核自动纳入勾选 / 持久化 / 渲染。

## Roadmap

- **卡顿帧定格**：单帧超阈值时快照各阶段耗时 + 环形缓冲，抓偶发尖刺（平均窗口会抹平的那种）。
- **可替换 renderer**：渲染层抽成接口，支持非 Cocos 环境。
