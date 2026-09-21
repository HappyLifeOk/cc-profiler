# cc-profiler — Cocos Creator 3.x 运行时性能监控面板

> 注册式、内核引擎无关的 Cocos Creator 3.x 性能监控面板库。`lib/core/` 纯 TS 零依赖，渲染层绑 Cocos。

## 特性

- **注册式**：指标 / 文本段运行时注册进来，内核不认识任何具体业务
- **内核引擎无关**：`lib/core/` 纯 TS，可单独用、可接其他渲染层
- **自带引擎指标**：fps / 帧耗时 / 各阶段耗时（逻辑/物理/渲染/提交）/ drawcall / 实例数 / 三角面 / 显存
- **结构化指标**：阈值标红、平均窗口、排序、格式化
- **默认开关态 + 用户选择持久化**：注册时声明 `defaultEnabled: false` 默认关；用户在 UI 上的开关存 `localStorage`，下次启动按用户选择来（`_touched` 集合区分"默认值生效" vs "用户已选择"，不互相覆盖）
- **双挂载模式**：可挂到宿主提供的现有 UI 节点并复用其 render layer；未提供宿主时回退独立 Canvas + Camera
- **输入透明**：覆写面板节点的 `UITransform.hitTest`，被覆盖的按钮可正常点
- **跨场景 fallback**：独立 Canvas 模式通过 `director.addPersistRootNode` 保持跨场景；宿主模式跟随宿主节点生命周期
- **宿主显式注册**：零配置时首帧自动装配并使用独立 Canvas + Camera；接入方可注册惰性宿主解析器
- **预览页 toolbar 联动**：初始化后监听 Cocos Creator 预览页 `Show FPS` 按钮的 click，点击即切换面板
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

不调用任何初始化函数时，模块会在首帧自动装配并联动预览页 toolbar 的 `Show FPS` 按钮。

已有 UI 框架、希望复用现有 Camera 时，显式注册宿主解析器。库只认识 `cc.Node`，不依赖宿主的 UIManager：

```ts
import { registerProfilerPanelHostProvider } from 'db://cc-profiler/cocos/cocos-profiler';

registerProfilerPanelHostProvider(() => getExistingTopUIRootOrNull());
```

未注册，或解析器当前返回 `null` 时，面板立即使用独立 Canvas + Camera；解析器之后返回有效宿主时，已显示的面板会自动迁移过去。因此接入方无需等待 UI 初始化，也无需设置超时。

## 用法

```ts
import { profiler } from 'db://cc-profiler/core/registry';
import {
    hideProfiler,
    initializeProfiler,
    registerProfilerPanelHostProvider,
    setProfilerEnabled,
    showProfiler,
} from 'db://cc-profiler/cocos/cocos-profiler';

// 可选：业务已有顶层 UI 宿主时注册；未就绪返回 null 即可
registerProfilerPanelHostProvider(() => getExistingTopUIRootOrNull());

// 可选：显式初始化；不调用时模块仍会在首帧自动初始化
initializeProfiler();

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

showProfiler();   // 显示面板；优先挂宿主节点，否则使用独立 fallback
hideProfiler();

// 嵌入态宿主静态关闭整套面板（toolbar / show 均 noop，已显示也立即 hide）
setProfilerEnabled(false);
```

## 屏幕日志

通用日志采集与缓冲位于 `lib/core/ScreenLog.ts`，Cocos 悬浮绘制位于 `lib/cocos/ScreenLogPanel.ts`。默认关闭，开启后观察控制台 log/info/debug/warn/error，支持来源、级别筛选、暂停、清空和有界缓冲；关闭后卸载自身包装。面板默认穿透游戏，标题栏可拖动，右上角“查看日志”按钮切换模式；切入查看模式后支持上下滚动全部缓存消息与异常详情，再点“穿透游戏”恢复游戏操作并跟随最新日志。只创建可见行及缓冲行节点并循环复用，上翻阅读历史时追加日志不抢回底部，关闭时释放整个节点池。点“收起”可最小化成可拖动的“日志 +”入口，点击展开；收起期间继续采集，暂停正文绘制，保留节点池、阅读位置和查看模式。首次收起沿用面板位置，此后入口与展开面板独立记忆拖动位置，在本次运行中保留并分别约束到屏幕内；普通日志白色、信息蓝色、调试灰色、警告黄色、错误红色，换行和节点复用均保留当前日志等级颜色。

```ts
import { screenLog } from 'db://cc-profiler/core/ScreenLog';
import { ScreenLogPanel } from 'db://cc-profiler/cocos/ScreenLogPanel';

const panel = new ScreenLogPanel(screenLog, () => screenLog.stop());
screenLog.start(); // 可传 (level, args) => boolean，接入宿主的日志过滤规则
panel.show(hostNode, overlayCamera); // 宿主传入顶层节点及对应相机
screenLog.append('network', 'warn', '连接重试'); // 可选的自定义来源
// panel.hide();
```

库不依赖项目的 Logger、GM 或触摸管理器。项目自行提供操作入口，并通过 `append` / `pinDetail` 接入日志来源。开启采集与显示独立：上述示例在关闭面板时停止采集。

向构造函数第三个参数传入 `(text: string) => void` 剪贴板回调后，查看模式下每条日志头部右侧显示“复制”。复制包含序号、时间、来源、等级和该条完整缓存正文，保留原始换行，不限于屏幕上的可见行（仍遵守采集时的 2000 字符上限）。固定异常详情也可复制。穿透模式不显示按钮；滚动取消和按钮复用会清除旧按压，避免复制错条。回调由宿主调用平台剪贴板并处理成功或失败提示。

每条日志按独立区块显示：小字号头部单独列出序号、产生时的本地时刻（HH:mm:ss）、来源和等级，正文及所有续行统一缩进。日志使用不透明深色底、头部分隔线和左侧等级色条，避免游戏画面和长消息混在一起；背景共用一个绘制节点，继续按可见文字行复用节点。

拖动右下角“↘”可分别调整窗口宽高，左上角位置保持不变；标题栏仍用于移动窗口。尺寸受最小操作区和屏幕边界约束。顶部仅保留“屏幕日志”标题和操作按钮，筛选、采集等状态在 GM 入口查看。本次运行中收起、展开及关闭重开保留选定尺寸；转屏时自动约束，查看历史时重排仍定位到原日志。缩放手势不传给底层游戏，排版每帧合并执行。

性能边界：同一可见行范围内滚动仅更新滚动条，不重画日志背景和文字；复制按钮仅在查看模式按可见标题分配并复用。大数组格式化最多读取前 20 项，不枚举全部索引。连续追加通过最多 200 次的变更记录增量更新排版，替换和淘汰只移除对应行；清空、筛选、宽度或异常详情变化，以及消费者落后超过增量窗口时回退全量同步。

执行 `npm ci && npm test` 可运行日志缓冲、控制台包装和绘制生命周期的专项模拟；不代替 Cocos 真机验证。

## 架构

| 层 | 路径 | 依赖 | 职责 |
|---|---|---|---|
| 内核 | `lib/core/` | 零（纯 TS） | 注册表 + Metric 模型 + 平均窗口 + `snapshot()` 渲染契约 + StorageAdapter 接口 |
| Cocos 适配 | `lib/cocos/` | `cc` | 面板渲染（宿主 Node 或独立 fallback）+ director hook 采样 + 引擎指标注册 + localStorage 持久化 + 预览 toolbar 联动 |

宿主侧只需用 `register` / `rawSection` 把自己的业务指标喂进来（显存、节点数、网络状态…），内核自动纳入勾选 / 持久化 / 渲染。

依赖方向始终是宿主接入层 → `cc-profiler`：宿主注册一个惰性解析函数，把自己的 UIManager 适配为 `cc.Node | null`；`cc-profiler` 不 import、也不认识任何外部 UI 框架。

## Cocos 初始化 API

```ts
import type { Node } from 'cc';

type ProfilerPanelHostProvider = () => Node | null;

registerProfilerPanelHostProvider(provider: ProfilerPanelHostProvider): void;
initializeProfiler(): Promise<void>;
```

- 不调用：模块首帧自动初始化，保留独立 Camera fallback。
- 调用 `initializeProfiler()`：显式触发初始化；宿主选择与初始化流程相互独立。
- 不注册宿主：始终使用默认独立 Canvas + Camera。
- 注册宿主：每次显示及显示期间惰性解析；返回 `null` 时继续使用默认面板，返回有效节点后自动挂载或迁移。
- 后一次注册会替换前一次解析器。

返回的宿主节点应当位于有效 UI 层级中，且它的 layer 必须被现有 Camera 的 visibility 覆盖。库只销毁自己的面板节点，不销毁宿主。

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
│       ├── panel.ts          # 面板渲染（宿主 Node + 独立 Canvas/Camera fallback）
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
- 改 `lib/cocos/panel.ts` 渲染相关：宿主模式不得销毁外部节点；fallback 模式继续使用 `Layers.Enum.PROFILER` 与独立 Camera。

## License

Apache License 2.0. See [LICENSE](./LICENSE).
