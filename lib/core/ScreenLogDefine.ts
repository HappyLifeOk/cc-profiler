/** 屏幕日志通用契约，不依赖业务或触摸平台。 */
export namespace ScreenLogDefine {
    /** 控制台原始等级，info/debug 仍保留各自标识。 */
    export type Level = 'log' | 'info' | 'debug' | 'warn' | 'error';
    /** 控制台包装保持参数和接收对象不变。 */
    export type ConsoleMethod = (...args: unknown[]) => void;
    /** 宿主日志规则：返回 false 时不采集，不影响原控制台输出。 */
    export type ConsoleFilter = (level: Level, args: readonly unknown[]) => boolean;
    /** 展示过滤不影响缓冲中的记录。 */
    export type Severity = 'all' | 'warning' | 'error';
    /** 内存上限与格式化上限，防止真机诊断无限增长。 */
    export const CAPACITY = 200;
    /** 单条日志最多保留的字符数。 */
    export const TEXT_LIMIT = 2000;
    /** 屏幕日志固定文字行高度，虚拟视口只创建可见行。 */
    export const ROW_HEIGHT = 25;
    /** 每行文字使用固定字体大小，长消息拆行而非缩小字体。 */
    export const FONT_SIZE = 19;
    /** 每条日志头部使用较小字号，与正文分层。 */
    export const ENTRY_HEADER_FONT_SIZE = 15;
    /** 日志头部右侧复制按钮宽度。 */
    export const COPY_BUTTON_WIDTH = 64;
    /** 日志块的水平留白；正文在头部基础上再缩进一档。 */
    export const ENTRY_INSET = 12;
    /** 固定标题和操作区高度。 */
    export const HEADER_HEIGHT = 48;
    /** 保留标题操作区可用的最小展开宽度；小屏以实际可用宽度为准。 */
    export const MIN_PANEL_WIDTH = 360;
    /** 最小展开高度，保留正文和缩放柄。 */
    export const MIN_PANEL_HEIGHT = 180;
    /** 右下角缩放柄尺寸，同时为底部提示区预留空间。 */
    export const RESIZE_HANDLE_SIZE = 36;
    /** 最小化入口尺寸，不占用原日志区域的触摸空间。 */
    export const MINIMIZED_WIDTH = 100;
    /** 最小化入口高度。 */
    export const MINIMIZED_HEIGHT = 44;
    /** 逻辑像素拖动阈值，区分入口点击与拖动。 */
    export const DRAG_THRESHOLD = 6;
    /** 已排版文字行的稳定身份，用于追加和淘汰消息时保持阅读位置。 */
    export interface Row {
        key: string;
        text: string;
        /** 换行和节点复用时保留原消息等级。 */
        level: Level;
        /** 头部独占一行，正文的所有续行保持同一缩进。 */
        kind: 'header' | 'body';
        /** 使用消息序号决定底色，追加及淘汰记录时不改变已有日志的颜色。 */
        band: number;
        /** 仅头部携带未换行的完整记录快照，供宿主复制。 */
        copyText?: string;
    }
    /** 深色悬浮面板使用的等级颜色，核心层仅保存 RGB 数值。 */
    export const LEVEL_COLORS: Record<Level, readonly [number, number, number]> = {
        /** 普通日志：白色。 */
        log: [255, 255, 255],
        /** 信息：浅蓝色。 */
        info: [115, 197, 255],
        /** 调试：灰色。 */
        debug: [163, 175, 188],
        /** 警告：黄色。 */
        warn: [255, 211, 95],
        /** 错误：红色。 */
        error: [255, 120, 120],
    };
    /** 需要观察的控制台方法。 */
    export const LEVELS: Level[] = ['log', 'info', 'debug', 'warn', 'error'];
    /** 一次追加及其替换、淘汰记录，最多保留 CAPACITY 次。 */
    export interface Change {
        revision: number;
        entry: Entry;
        removed: readonly number[];
    }
    /** 记录只保存文字快照，不持有业务对象。 */
    export interface Entry {
        /** 所有来源共用的递增序号。 */
        sequence: number;
        /** 采集时的设备本地时刻 HH:mm:ss，只格式化一次，后续显示保持不变。 */
        time: string;
        /** console、touch 或调用方指定的来源。 */
        source: string;
        /** 原始日志等级。 */
        level: Level;
        /** 有长度上限的内容快照。 */
        text: string;
        /** 高频状态的替换键；普通事件为空字符串。 */
        replaceKey: string;
    }
}
