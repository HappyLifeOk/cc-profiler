import type { ScreenLog } from './ScreenLog';
import { ScreenLogDefine as D } from './ScreenLogDefine';

/** 日志文字排版和阅读位置；不依赖 Cocos，不为历史消息持有节点。 */
export class ScreenLogViewport {
    private _rows: D.Row[] = [];
    private readonly _cache = new Map<string, { header: string; text: string; columns: number; level: D.Level; rows: D.Row[] }>();
    private _clearVersion = -1;
    private _filter = '';
    private _revision = -1;
    private _columns = 0;
    private _height = 0;
    private _offset = 0;
    private _following = true;

    get rows(): readonly D.Row[] { return this._rows; }
    get offset(): number { return this._offset; }
    get following(): boolean { return this._following; }
    get contentHeight(): number { return Math.max(this._height, this._rows.length * D.ROW_HEIGHT); }
    get maxOffset(): number { return Math.max(0, this.contentHeight - this._height); }

    /** 由真实滚动位置更新跟随状态，滑回底部即可继续跟随。 */
    scroll(offset: number): void {
        this._offset = Math.max(0, Math.min(offset, this.maxOffset));
        this._following = this.maxOffset - this._offset <= 2;
    }

    /** 仅重排新增或变化的消息；保留当前行身份和行内偏移，历史淘汰时钳到最早可用行。 */
    update(log: ScreenLog, columns: number, height: number): void {
        const index = Math.floor(this._offset / D.ROW_HEIGHT);
        const anchor = this._rows[index];
        let inset = this._offset - index * D.ROW_HEIGHT;
        const filter = `${log.source}/${log.severity}`;
        const reset = this._clearVersion !== log.clearVersion || this._filter !== filter;
        this._clearVersion = log.clearVersion;
        this._filter = filter;
        this._height = Math.max(D.ROW_HEIGHT, height);
        const changes = !reset && columns === this._columns ? log.changesSince(this._revision) : null;
        this._revision = log.revision;
        this._columns = columns;
        const used = new Set<string>();
        const rows: D.Row[] = changes ? this._rows : [];
        const append = (key: string, header: string, text: string, level: D.Level, band: number): void => {
            used.add(key);
            let cached = this._cache.get(key);
            if (!cached || cached.header !== header || cached.text !== text || cached.columns !== columns || cached.level !== level) {
                const lines: D.Row[] = header
                    ? [{ key: `${key}:header`, text: header, level, kind: 'header', band, copyText: `${header}\n${text}` }]
                    : [];
                this._wrap(text, Math.max(8, columns)).forEach((line, lineIndex) => {
                    lines.push({ key: `${key}:${lineIndex}`, text: line, level, kind: 'body', band });
                });
                cached = { header, text, columns, level, rows: lines };
                this._cache.set(key, cached);
            }
            rows.push(...cached.rows);
        };
        const appendEntry = (entry: D.Entry): void => {
            const source = entry.source === 'console' ? '控制台' : entry.source === 'touch' ? '触摸' : entry.source;
            const header = `#${entry.sequence}  ${entry.time}  ${source} · ${entry.level.toUpperCase()}`;
            append(`entry:${entry.sequence}`, header, entry.text, entry.level, entry.sequence % 2);
        };
        if (changes) {
            // 普通追加只拼接新行；替换和淘汰仅移除对应记录，不重建历史行列表。
            if (changes.length && this._cache.has('empty')) {
                rows.length = 0;
                this._cache.delete('empty');
            }
            for (const change of changes) {
                for (const sequence of change.removed) {
                    const key = `entry:${sequence}`;
                    const cached = this._cache.get(key);
                    if (!cached) continue;
                    const start = rows.indexOf(cached.rows[0]);
                    if (start >= 0) rows.splice(start, cached.rows.length);
                    this._cache.delete(key);
                }
                const entry = change.entry;
                if ((!log.source || entry.source === log.source) && (log.severity === 'all'
                    || entry.level === 'error' || (log.severity === 'warning' && entry.level === 'warn'))) appendEntry(entry);
            }
        } else {
            const detail = log.getDetail();
            if (detail) append('detail', '固定 · 首个异常详情', detail, 'warn', 0);
            for (const entry of log.recent(D.CAPACITY)) appendEntry(entry);
        }
        if (!rows.length) append('empty', '', '暂无匹配日志', 'debug', 0);
        if (!changes) for (const key of this._cache.keys()) if (!used.has(key)) this._cache.delete(key);
        this._rows = rows;
        if (reset) this._following = true;
        if (this._following) this._offset = this.maxOffset;
        else {
            let next = anchor ? rows.findIndex(row => row.key === anchor.key) : -1;
            if (next < 0 && anchor) {
                // 宽度变大后原续行可能消失，回到同一条日志的头部，避免跳到最早记录。
                const entryPrefix = anchor.key.slice(0, anchor.key.lastIndexOf(':') + 1);
                next = rows.findIndex(row => row.key.startsWith(entryPrefix));
                inset = 0;
            }
            this._offset = Math.min(this.maxOffset, next < 0 ? 0 : next * D.ROW_HEIGHT + inset);
        }
    }

    /** 上下各多保留一行缓冲，节点数只与视口高度有关。 */
    range(): { start: number; end: number } {
        return {
            start: Math.max(0, Math.floor(this._offset / D.ROW_HEIGHT) - 1),
            end: Math.min(this._rows.length, Math.ceil((this._offset + this._height) / D.ROW_HEIGHT) + 1),
        };
    }

    clear(): void {
        this._rows = [];
        this._cache.clear();
        this._clearVersion = -1;
        this._offset = 0;
        this._following = true;
    }

    /** 等宽显示：中文按双宽处理，换行和制表符保留可读结构。 */
    private _wrap(text: string, columns: number): string[] {
        const lines: string[] = [];
        for (const paragraph of text.split('\n')) {
            let line = '', width = 0;
            for (const char of paragraph.split('\t').join('    ')) {
                if (char === '\r') continue;
                const units = char.codePointAt(0) > 255 ? 2 : 1;
                if (width + units > columns && line) {
                    lines.push(line); line = ''; width = 0;
                }
                line += char;
                width += units;
            }
            lines.push(line);
        }
        return lines;
    }
}
