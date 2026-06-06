// profiler — cocos/panel.ts
// 渲染层（绑 Cocos）。运行时查找场景 Canvas，把面板挂为其最上层子节点（复用场景 camera，不自建）。
// 不依赖宿主 UI 框架：只认场景里的 Canvas。消费 core 的 Row[]，单 RichText 渲染、warn 行标红。

import { Node, UITransform, RichText, Layout, Widget, Color, Layers, ScrollView, Mask, Graphics, HorizontalTextAlignment, Canvas, director } from 'cc';
import { Row } from '../core/metric';

const PANEL_W = 340;   // 面板宽
const PANEL_H = 480;   // 可视高（固定；内容超出竖向滚动）
const LINE_H = 32;     // 行高
const FONT = 24;       // 字号
const PAD = 12;        // 内边距
const COLOR_NORMAL = 'ffffff';
const COLOR_WARN = 'ff5555';

/** 性能面板：挂到场景 Canvas 最上层。纯展示，不碰数据采集，不依赖宿主框架。 */
export class ProfilerPanel {
    private _root: Node = null;
    private _rich: RichText = null;

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

        // 根 = 面板容器：贴左下、半透明黑底、竖向滚动
        const root = new Node('ProfilerPanel');
        root.layer = uiLayer;
        const rootUT = root.addComponent(UITransform);
        rootUT.setContentSize(PANEL_W, PANEL_H);
        rootUT.setAnchorPoint(0, 0);

        const bg = root.addComponent(Graphics);
        bg.fillColor = new Color(0, 0, 0, 160);
        bg.rect(0, 0, PANEL_W, PANEL_H);
        bg.fill();

        const widget = root.addComponent(Widget);
        widget.isAlignLeft = true;
        widget.isAlignBottom = true;
        widget.left = 10;
        widget.bottom = 10;
        widget.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;

        const sv = root.addComponent(ScrollView);
        sv.horizontal = false;
        sv.vertical = true;
        sv.inertia = true;
        sv.brake = 0.5;
        sv.elastic = true;
        sv.bounceDuration = 0.23;

        // view：Mask 裁剪。anchor(0,1) 顶边放到 y=PANEL_H 覆盖 [0,PANEL_H]
        const viewNode = new Node('view');
        viewNode.layer = uiLayer;
        const viewUT = viewNode.addComponent(UITransform);
        viewUT.setContentSize(PANEL_W, PANEL_H);
        viewUT.setAnchorPoint(0, 1);
        viewNode.addComponent(Mask);
        viewNode.parent = root;
        viewNode.setPosition(0, PANEL_H, 0);

        // content：Layout(VERTICAL+CONTAINER) 随子节点自动撑高
        const contentNode = new Node('content');
        contentNode.layer = uiLayer;
        const contentUT = contentNode.addComponent(UITransform);
        contentUT.setContentSize(PANEL_W, PANEL_H);
        contentUT.setAnchorPoint(0, 1);
        contentNode.parent = viewNode;
        contentNode.setPosition(0, 0, 0);
        const layout = contentNode.addComponent(Layout);
        layout.type = Layout.Type.VERTICAL;
        layout.resizeMode = Layout.ResizeMode.CONTAINER;
        layout.paddingTop = PAD;
        layout.paddingBottom = PAD;
        layout.paddingLeft = PAD;
        layout.paddingRight = PAD;

        // RichText：固定宽 maxWidth 自动换行、高度随内容；warn 行用 color 标签标红
        const richNode = new Node('rich');
        richNode.layer = uiLayer;
        const richUT = richNode.addComponent(UITransform);
        richUT.setContentSize(PANEL_W - PAD * 2, LINE_H);
        richUT.setAnchorPoint(0, 1);
        richNode.parent = contentNode;
        const rich = richNode.addComponent(RichText);
        rich.fontSize = FONT;
        rich.lineHeight = LINE_H;
        rich.maxWidth = PANEL_W - PAD * 2;
        rich.horizontalAlign = HorizontalTextAlignment.LEFT;
        rich.string = '';

        sv.content = contentNode;

        // 挂到场景 Canvas 下，置为最后一个子节点（Cocos 渲染顺序：靠后在最上层，不被其他 UI 盖住）
        canvasNode.addChild(root);
        root.setSiblingIndex(canvasNode.children.length - 1);
        widget.updateAlignment();

        this._root = root;
        this._rich = rich;
    }

    public hide(): void {
        if (this._root && this._root.isValid) this._root.destroy();
        this._root = null;
        this._rich = null;
    }

    /** 把 Row[] 渲染成富文本：每行包 color 标签（warn 红、正常白）。 */
    public render(rows: Row[]): void {
        if (!this._rich || !this._rich.isValid) return;
        const lines: string[] = [];
        rows.forEach((r) => {
            const color = r.warn ? COLOR_WARN : COLOR_NORMAL;
            lines.push(`<color=#${color}>${r.text}</color>`);
        });
        this._rich.string = lines.join('\n');
    }
}
