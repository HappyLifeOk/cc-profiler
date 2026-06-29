# cc-profiler — Cocos Creator 3.x 运行时性能监控面板

> 注册式、内核引擎无关的 Cocos Creator 3.x 性能监控面板库。`lib/core/` 纯 TS 零依赖，渲染层绑 Cocos。

## 特性

- **注册式**：指标 / 文本段运行时注册进来，内核不认识任何具体业务
- **内核引擎无关**：`lib/core/` 纯 TS，可单独用、可接其他渲染层
- **自带引擎指标**：fps / 帧耗时 / 各阶段耗时（逻辑/物理/渲染/提交）/ drawcall / 实例数 / 三角面 / 显存
- **结构化指标**：阈值标红、平均窗口、排序、格式化
- **默认开关态 + 用户选择持久化**：注册时声明 `defaultEnabled: false` 默认关；用户在 UI 上的开关存 `localStorage`，下次启动按用户选择来（`_touched` 集合区分"默认值生效" vs "用户已选择"，不互相覆盖）
- **独立 Canvas + Camera 隔离渲染**：用引擎自带的 `Layers.Enum.PROFILER` 层 + 独立 Camera（priority 极高），物理隔离业务任何 UI 都覆盖不到
- **输入透明**：覆写面板节点的 `UITransform.hitTest`，被覆盖的按钮可正常点
- **跨场景持久挂载**：通过 `director.addPersistRootNode` 标记，切场景时引擎不销毁面板节点，无需重挂
- **预览页 toolbar 联动**：自动监听 Cocos Creator 预览页 `Show FPS` 按钮的 click，点击即切换面板，无需业务侧显式接入
- **全局静态开关**：`setProfilerEnabled(false)` 一键关，`showProfiler` / toolbar 联动均 noop、已显示也立即 hide。供 iframe 嵌入态宿主一行压住面板自启，无需跟 toolbar bind 抢时序
- **Label CHAR 池化**：文本逐行用 Label + `cacheMode = CHAR`，多行 Label 共享字符 atlas batch 成单 drawcall，面板自身渲染开销稳定可预期
- **持久化**：勾选状态存 `localStorage`，可换实现

## 兼容性

Cocos Creator `>= 3.8.0`。已在 3.8.5 / 3.8.7 / 3.8.8 上验证。

## 接入

本库通过扩展 `asset-db.mount` 把 `./lib` 挂成独立 db 根 `db://cc-profiler`（见 `package.json`），业务侧直接 import，无需放进项目 `assets/`：

把目录放到项目 `extensions/cc-profiler/`（或作为 git submodule）即可。然后任意脚本里加一行：

```ts
import 'db://cc-profiler/cocos/cocos-profiler';
```

模块加载即自动联动预览页 toolbar 的 `Show FPS` 按钮，点击即出现面板。无需更多接入。

## 用法

```ts
import { profiler } from 'db://cc-profiler/core/registry';
import { showProfiler, hideProfiler, setProfilerEnabled } from 'db://cc-profiler/cocos/cocos-profiler';

// 结构化指标
profiler.register({
    id: 'fps', label: '帧率',
    get: () => currentFps,
    warn: v => v < 30,        // 低于 30 标红
    format: v => v.toFixed(0),
    average: 500,             // 500ms 平均窗口
    defaultEnabled: false,    // 注册时默认关，用户从未操作过时生效
});

// 自定义文本段（复杂展示逃生舱），第 4 参 defaultEnabled 缺省 true
profiler.rawSection('net', () => `网络: ${connected ? '已连接' : '断开'}`, 70, false);

showProfiler();   // 显示面板（自建挂载，无需传节点）
hideProfiler();

// 嵌入态宿主静态关闭整套面板（toolbar 自启 / show / GM 切换全部 noop，已显示也立即 hide）
// 只要在 module 加载后、首帧 AFTER_UPDATE 触发前同步调一次，import 顺序就能保证时序
setProfilerEnabled(false);
```

## 架构

| 层 | 路径 | 依赖 | 职责 |
|---|---|---|---|
| 内核 | `lib/core/` | 零（纯 TS） | 注册表 + Metric 模型 + 平均窗口 + `snapshot()` 渲染契约 + StorageAdapter 接口 |
| Cocos 适配 | `lib/cocos/` | `cc` | 面板渲染（独立 Canvas+Camera+PROFILER 层）+ director hook 采样 + 引擎指标注册 + localStorage 持久化 + 预览 toolbar 联动 |

宿主侧只需用 `register` / `rawSection` 把自己的业务指标喂进来（显存、节点数、网络状态…），内核自动纳入勾选 / 持久化 / 渲染。

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
    defaultEnabled?: boolean;      // 注册时是否默认启用（缺省 true），仅在用户从未操作过时生效
}
profiler.register(m: Metric): void;
profiler.rawSection(id, provider: () => string, order?, defaultEnabled?): void;
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
- **默认开关 + 用户选择**：内置 `_touched` 集合区分"默认值生效" vs "用户已选择"。注册时 `defaultEnabled: false` 只在用户从未操作过该项时生效，操作过即以用户选择为准。持久化格式 `{ disabled, touched }`，兼容旧字符串数组。

## 目录

```text
cc-profiler/
├── lib/                       # 挂成 db://cc-profiler（asset-db.mount ./lib）
│   ├── core/                  # 纯 TS，零引擎依赖
│   │   ├── registry.ts       # 注册表 + list/setEnabled/sample/snapshot + 单例 profiler
│   │   ├── metric.ts         # Metric / Row 接口 + Averager 平均窗口
│   │   └── storage.ts        # StorageAdapter 接口 + MemoryStorage 默认实现
│   └── cocos/                 # Cocos 适配
│       ├── cocos-profiler.ts # 装配：director hook 采集 + 驱动 + 引擎指标 + show/hide + toolbar 联动
│       ├── panel.ts          # 面板渲染（独立 Canvas + Camera + PROFILER 层）
│       └── local-storage.ts  # StorageAdapter 的 window.localStorage 实现
├── package.json               # 扩展声明 + asset-db.mount
├── LICENSE                    # Apache 2.0
└── README.md
```

## 扩展点

- **换持久化**：实现 `StorageAdapter`（load/save）+ `profiler.setStorage()`。默认 `window.localStorage`，换平台只改这一个文件。
- **换渲染层**：core 的 `snapshot(): Row[]` 是渲染契约，另写一个消费 `Row[]` 的 renderer 即可脱离 Cocos。
- **加业务指标**：`register` / `rawSection` 注册，内核自动纳入勾选 / 持久化 / 渲染。

## Roadmap

- **卡顿帧定格**：单帧超阈值时快照各阶段耗时 + 环形缓冲，抓偶发尖刺（平均窗口会抹平的那种）。
- **可替换 renderer**：渲染层抽成接口，支持非 Cocos 环境（core 已经引擎无关，差一层 renderer 解耦）。

## 贡献

欢迎 issue / PR：

- 请说明使用的 Cocos Creator 版本、复现步骤、期望行为。
- bug 修复 PR 请附最小复现；新功能 PR 请先开 issue 讨论方案。
- 改 `lib/core/` 注意保持零引擎依赖（不要 import `cc`）。
- 改 `lib/cocos/panel.ts` 渲染相关：面板必须挂在 `Layers.Enum.PROFILER` 层并使用独立 Camera，避免被业务 UI 遮挡。

## License

Apache License 2.0. See [LICENSE](./LICENSE).
