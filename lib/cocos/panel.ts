// profiler — cocos/panel.ts
// 渲染层（绑 Cocos）。运行时查找场景 Canvas，把面板挂为其最上层子节点（复用场景 camera，不自建）。
// 不依赖宿主 UI 框架：只认场景里的 Canvas。消费 core 的 Row[]，单 RichText 渲染、warn 行标红。
// 不滚动、不遮挡点击、不换行：面板宽高都随内容动态撑开，每条 Row 恒占一行。

import { Node, UITransform, RichText, Widget, Color, Graphics, HorizontalTextAlignment, Canvas, director } from 'cc';
import { Row } from '../core/metric';

const MIN_W = 200;     // 空内容兜底宽
const LINE_H = 32;     // 行高
const FONT = 24;       // 字号
const PAD = 12;        // 内边距
const LEADING = LINE_H - FONT;  // 单行 lineHeight 框比字形高出的 leading；只出现在最后一行下方，需补偿对齐
const COLOR_NORMAL = 'ffffff';
const COLOR_WARN = 'ff5555';

/** 性能面板：挂到场景 Canvas 最上层。纯展示，不碰数据采集，不依赖宿主框架。 */
export class ProfilerPanel {
    private _root: Node = null;
    private _rich: RichText = null;
    private _bg: Graphics = null;

    public isShowing(): boolean {
        return !!this._root && this._root.isValid;
    }

    /** 查找场景 Canvas，把面板挂为其最上层子节点。无 Canvas 则跳过并告警。 */
    public show(): void {
        if (this.isShowing()) return;
        const scene = director.getScene();
        if (!scene) {
            console.warn('ProfilerPanel', 'show 失败：当前无场景');
            return;
        }
        // 项目多场景结构：场景里有多个 Canvas，第二个才是 UI 绘制层（第一个非 UI）；不足 2 个时退到第一个
        const canvases = scene.getComponentsInChildren(Canvas);
        if (canvases.length === 0) {
            console.warn('ProfilerPanel', 'show 失败：场景内未找到 Canvas');
            return;
        }
        const canvasNode = (canvases.length >= 2 ? canvases[1] : canvases[0]).node;
        const uiLayer = canvasNode.layer;   // 跟随 Canvas 的 layer，确保被同一 camera 渲染

        // 根 = 面板容器：贴左下、宽高都随内容增长（anchor(0,0) → 向右上撑开）
        const root = new Node('ProfilerPanel');
        root.layer = uiLayer;
        const rootUT = root.addComponent(UITransform);
        rootUT.setContentSize(MIN_W, PAD * 2 + LINE_H);
        rootUT.setAnchorPoint(0, 0);

        const bg = root.addComponent(Graphics);
        bg.fillColor = new Color(0, 0, 0, 160);

        const widget = root.addComponent(Widget);
        widget.isAlignLeft = true;
        widget.isAlignBottom = true;
        widget.left = 10;
        widget.bottom = 10;
        widget.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;

        // RichText 子节点：anchor(0,0) 贴底左，左下角偏 PAD 留出内边距
        const richNode = new Node('rich');
        richNode.layer = uiLayer;
        const richUT = richNode.addComponent(UITransform);
        richUT.setContentSize(MIN_W - PAD * 2, LINE_H);
        richUT.setAnchorPoint(0, 0);
        richNode.parent = root;
        // 整体下移 LEADING，使最后一行字形底部对齐到 y=PAD（与顶部 PAD 视觉对称）
        richNode.setPosition(PAD, PAD - LEADING, 0);
        const rich = richNode.addComponent(RichText);
        rich.fontSize = FONT;
        rich.lineHeight = LINE_H;
        // 不设 maxWidth：禁止自动换行，每条 Row 一行；面板宽度按 RichText 实际宽度动态撑开
        rich.horizontalAlign = HorizontalTextAlignment.LEFT;
        rich.string = '';

        // 挂到场景 Canvas 下，置为最后一个子节点（Cocos 渲染顺序：靠后在最上层，不被其他 UI 盖住）
        canvasNode.addChild(root);
        root.setSiblingIndex(canvasNode.children.length - 1);
        widget.updateAlignment();

        // 输入透明：RichText.onEnable 会注册 TOUCH_END listener 处理 <on click> 标签，
        // 在 Cocos 3.x 输入分发里"命中即吃掉"，会挡住下层按钮。覆写 hitTest 返回 false 让命中测试跳过本面板
        const noHit = (): boolean => false;
        rootUT.hitTest = noHit;
        richUT.hitTest = noHit;

        this._root = root;
        this._rich = rich;
        this._bg = bg;
        this._resize(MIN_W - PAD * 2, LINE_H);
    }

    public hide(): void {
        if (this._root && this._root.isValid) this._root.destroy();
        this._root = null;
        this._rich = null;
        this._bg = null;
    }

    /** 把 Row[] 渲染成富文本：每行包 color 标签（warn 红、正常白）。同时按 RichText 实际渲染宽高撑开面板并重绘黑底。 */
    public render(rows: Row[]): void {
        if (!this._rich || !this._rich.isValid) return;
        const lines: string[] = [];
        rows.forEach((r) => {
            const color = r.warn ? COLOR_WARN : COLOR_NORMAL;
            lines.push(`<color=#${color}>${r.text}</color>`);
        });
        this._rich.string = lines.join('\n');

        // RichText.string setter 内部同步执行 layout，会把 node 的 UITransform 调整到实际渲染尺寸。
        // 没设 maxWidth → 宽度 = 最长行宽，高度 = 行数 × lineHeight。
        const richUT = this._rich.node.getComponent(UITransform);
        const richW = richUT == null ? MIN_W - PAD * 2 : richUT.contentSize.width;
        const richH = richUT == null ? LINE_H : richUT.contentSize.height;
        this._resize(richW, richH);
    }

    /** 按 RichText 实际宽高撑开 root + 重绘背景。anchor(0,0) + Widget bottom-left 保证向右上展开。 */
    private _resize(richWidth: number, richHeight: number): void {
        if (!this._root || !this._root.isValid) return;
        const w = Math.max(MIN_W, PAD * 2 + richWidth);
        // 减去 LEADING：底部 leading 已经通过 rich 下移消除，顶部 leading 不存在（首行字形贴 lineHeight 框上沿）
        const h = PAD * 2 + richHeight - LEADING;
        const ut = this._root.getComponent(UITransform);
        if (ut == null) return;
        ut.setContentSize(w, h);

        if (this._bg == null) return;
        this._bg.clear();
        this._bg.fillColor = new Color(0, 0, 0, 160);
        this._bg.rect(0, 0, w, h);
        this._bg.fill();
    }
}
