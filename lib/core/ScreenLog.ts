import { ScreenLogDefine as D } from './ScreenLogDefine';

/** 默认不采集；开启期间提供有界日志缓冲和可撤销的控制台观察。 */
export class ScreenLog {
    private readonly _entries: D.Entry[] = [];
    private readonly _details = new Map<string, string>();
    private readonly _restore: (() => void)[] = [];
    private _enabled = false;
    private _sequence = 0;
    /** 旧包装即使被其他工具保留，也不能在重开后重复采集。 */
    private _generation = 0;
    /** 过滤器或对象枚举可能再次打印日志；原输出保留，采集不重入。 */
    private _capturing = false;
    private _revision = 0;
    private _clearVersion = 0;
    private readonly _changes: D.Change[] = [];
    /** 暂停采集，控制台和业务仍照常运行。 */
    paused = false;
    /** 空字符串表示全部来源。 */
    source = '';
    /** 级别筛选仅在读取时应用。 */
    severity: D.Severity = 'all';

    /** 当前是否正在接受记录。 */
    get enabled(): boolean { return this._enabled; }
    /** 渲染方据此判断是否需要更新文字。 */
    get revision(): number { return this._revision; }
    /** 清空和重开后的记录序号会复用，显示方据此重置阅读锚点。 */
    get clearVersion(): number { return this._clearVersion; }

    /** 只在用户开启面板后包装控制台，重复调用不叠加；宿主可注入过滤策略，默认采集全部输出。 */
    start(acceptConsole?: D.ConsoleFilter, observeConsole?: D.ConsoleObserver): void {
        if (this._enabled) return;
        this.clear();
        this.paused = false;
        this._enabled = true;
        const generation = ++this._generation;
        const capture = (level: D.Level, args: readonly unknown[]): void => {
            if (!this.enabled || this.paused || this._generation !== generation || this._capturing) return;
            this._capturing = true;
            try {
                if (acceptConsole && !acceptConsole(level, args)) return;
                this.append('console', level, ScreenLog.format(args));
            } catch {
                // 诊断失败只跳过本条采集，不影响业务，也不递归打印。
            } finally {
                this._capturing = false;
            }
        };
        if (observeConsole) {
            this._restore.push(observeConsole(capture));
            return;
        }
        for (const level of D.LEVELS) {
            const original = console[level];
            if (typeof original !== 'function') continue;
            const hook: D.ConsoleMethod = function (this: Console, ...args): void {
                original.apply(this, args);
                capture(level, args);
            };
            console[level] = hook;
            this._restore.push(() => {
                /** 宿主或其他工具已替换该方法时，不覆盖它们的新入口。 */
                if (console[level] === hook) console[level] = original;
            });
        }
    }

    /** 先停采集，再恢复仍由自己持有的控制台包装。 */
    stop(): void {
        this._enabled = false;
        this._generation++;
        this.paused = false;
        for (const restore of this._restore) restore();
        this._restore.length = 0;
        this.clear();
    }

    /** 清空记录与异常详情并重置序号，保留用户的显示筛选。 */
    clear(): void {
        this._clearVersion++;
        this._changes.length = 0;
        this._entries.length = 0;
        this._details.clear();
        this._sequence = 0;
        this._revision++;
    }

    /** 通用来源入口；replaceKey 只用于 MOVE 等可合并状态，END 等关键事件不得传入。 */
    append(source: string, level: D.Level, text: string, replaceKey = ''): void {
        if (!this._enabled || this.paused) return;
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        const removed: number[] = [];
        if (replaceKey) {
            const old = this._entries.findIndex(e => e.source === source && e.replaceKey === replaceKey);
            if (old >= 0) removed.push(this._entries.splice(old, 1)[0].sequence);
        }
        const entry: D.Entry = {
            sequence: ++this._sequence, time,
            source, level, text: text.slice(0, D.TEXT_LIMIT), replaceKey,
        };
        this._entries.push(entry);
        if (this._entries.length > D.CAPACITY) removed.push(this._entries.shift().sequence);
        this._revision++;
        this._changes.push({ revision: this._revision, entry, removed });
        if (this._changes.length > D.CAPACITY) this._changes.shift();
    }

    /** 保存该来源的首个异常详情，后续事件不得冲掉取证内容。 */
    pinDetail(source: string, text: string): void {
        if (!this._enabled || this.paused || this._details.has(source) || this._details.size >= 20) return;
        this._details.set(source, text.slice(0, D.TEXT_LIMIT));
        this._changes.length = 0;
        this._revision++;
    }

    /** 连续追加的有界增量；清空、详情变化或消费者落后太多时要求全量同步。 */
    changesSince(revision: number): readonly D.Change[] {
        if (revision === this._revision) return [];
        const first = this._changes[0];
        if (!first || revision < first.revision - 1 || revision > this._revision) return null;
        return this._changes.slice(revision - first.revision + 1);
    }

    /** 采集方可在展开大对象前跳过已经保存的详情。 */
    hasDetail(source: string): boolean { return this._details.has(source); }

    /** 详情只随匹配来源及全部级别显示，避免干扰错误筛选。 */
    getDetail(): string {
        if (this.severity !== 'all') return '';
        return Array.from(this._details).filter(([source]) => !this.source || source === this.source)
            .map(([source, text]) => `[${source}] ${text}`).join('\n');
    }

    /** 返回新数组，调用方不能修改内部缓冲；结果始终按采集顺序排列。 */
    recent(limit = 14): readonly Readonly<D.Entry>[] {
        return this._entries.filter(e => (!this.source || e.source === this.source)
            && (this.severity === 'all' || e.level === 'error' || (this.severity === 'warning' && e.level === 'warn')))
            .slice(-limit);
    }

    /** 格式化不调用 getter、toJSON 或对象的 toString，按节点数、深度与字数限制快照开销。 */
    static format(values: readonly unknown[]): string {
        const seen = new Set<object>();
        let remaining = 80;
        const describe = (value: unknown, depth: number): string => {
            if (--remaining < 0) return '…';
            if (typeof value === 'function') return '[函数]';
            if (value === null || typeof value !== 'object') return String(value).slice(0, D.TEXT_LIMIT);
            if (seen.has(value)) return '[重复引用]';
            if (depth > 3) return '[深度上限]';
            seen.add(value);
            const fields: string[] = [];
            // 数组只读取前 20 项，避免为了截断输出先枚举全部索引。
            const array = Array.isArray(value);
            const length = array ? Object.getOwnPropertyDescriptor(value, 'length').value as number : 0;
            const names = array
                ? Array.from({ length: Math.min(20, length) }, (_, index) => String(index))
                : Object.getOwnPropertyNames(value);
            for (const key of names) {
                if (remaining <= 0 || fields.length >= 20) { fields.push('…'); break; }
                const property = Object.getOwnPropertyDescriptor(value, key);
                fields.push(`${key}: ${property && 'value' in property ? describe(property.value, depth + 1) : '[getter]'}`);
            }
            if (array && length > 20) fields.push('…');
            return `{${fields.join(', ')}}`.slice(0, D.TEXT_LIMIT);
        };
        return values.slice(0, 20).map(value => describe(value, 0)).join(' ').slice(0, D.TEXT_LIMIT);
    }
}

/** 调试来源共用实例；关闭时 append 是空操作，不会缓存业务数据。 */
export const screenLog = new ScreenLog();
