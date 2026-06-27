// Copyright (c) cc-profiler contributors
// SPDX-License-Identifier: Apache-2.0
//
// profiler — cocos/panel.ts
// 渲染层（绑 Cocos）。自建独立 Canvas + Camera + Layers.PROFILER 层，
// 渲染层级凌驾于宿主任何 Canvas 之上，物理隔离不被业务 UI 遮挡。
// 消费 core 的 Row[]，单 RichText 渲染、warn 行标红。
// 不滚动、不遮挡点击、不换行：宽度固定避免数字波动抖动，高度按行数动态撑开，每条 Row 恒占一行。

import { Node, UITransform, RichText, Widget, Color, Graphics, HorizontalTextAlignment, Canvas, Camera, Layers, director, view } from 'cc';
import { Row } from '../core/metric';

const PANEL_W = 360;   // 容器固定宽（含内边距）：按"标签 + 数值"最长行预留缓冲，避免数字波动时容器宽抖动
const LINE_H = 32;     // 行高
const FONT = 24;       // 字号
const PAD = 12;        // 内边距
const LEADING = LINE_H - FONT;  // 单行 lineHeight 框比字形高出的 leading；只出现在最后一行下方，需补偿对齐
const CAMERA_PRIORITY = (1 << 30) + 100;   // 默认 UI Camera priority = 1<<30；+100 确保面板凌驾于业务 camera 之上
const COLOR_NORMAL = 'ffffff';
const COLOR_WARN = 'ff5555';

/** 性能面板：自建 Canvas + Camera 独立渲染。纯展示，不碰数据采集，不依赖宿主框架。 */
export class ProfilerPanel {
    private _cnvRoot: Node = null;   // 自建 Canvas 节点（hide 时销毁，子节点跟着死）
    private _root: Node = null;
    private _rich: RichText = null;
    private _bg: Graphics = null;

    public isShowing(): boolean {
        return !!this._cnvRoot && this._cnvRoot.isValid;
    }

    /** 自建独立 Canvas + Camera 渲染面板，挂在 PROFILER 层，业务 camera 看不到本层 → 物理隔离。 */
    public show(): void {
        if (this.isShowing()) return;
        const scene = director.getScene();
        if (!scene) {
            console.warn('ProfilerPanel', 'show 失败：当前无场景');
            return;
        }

        // 关键：Camera 必须放在 Canvas 节点的【子节点】上，不能跟 Canvas 同节点。
        // 原因：Canvas._onResizeCamera() 会调 cameraComponent.node.setWorldPosition(canvas.x, canvas.y, 1000)。
        // 同节点 → camera 把自己（Canvas 节点）z 拉到 1000，UI 子节点世界 z=1000 等于 camera z，落在 near 内被裁掉，画面全黑

        // Canvas 节点：手动配 UITransform.size = visibleSize、position 在屏幕中心
        // 用 visibleSize 不是 designResolutionSize——后者是策划设计分辨率，fit mode 让实际可见区域可能更大/更小，
        // 不用 visibleSize 的话 Widget bottom=10 算出的"父节点底"对不上真实屏幕底，面板就漂到中间去了
        const visibleSize = view.getVisibleSize();
        const cnvNode = new Node('ProfilerCanvas');
        cnvNode.layer = Layers.Enum.PROFILER;
        const cnvUT = cnvNode.addComponent(UITransform);
        cnvUT.setContentSize(visibleSize.width, visibleSize.height);
        cnvNode.setPosition(visibleSize.width / 2, visibleSize.height / 2, 0);

        // Camera 独立子节点：Canvas._onResizeCamera 把它放到 (canvasX, canvasY, 1000) 看 -Z
        const camNode = new Node('ProfilerCamera');
        camNode.layer = Layers.Enum.PROFILER;
        camNode.parent = cnvNode;
        const cam = camNode.addComponent(Camera);
        cam.projection = Camera.ProjectionType.ORTHO;
        cam.visibility = Layers.Enum.PROFILER;   // 只渲染 PROFILER 层：业务 camera visibility 不含本层，互不干扰
        cam.priority = CAMERA_PRIORITY;
        cam.clearFlags = Camera.ClearFlag.DONT_CLEAR;   // 多 camera 叠加渲染，不清屏
        cam.near = 1;
        cam.far = 2000;

        const cnv = cnvNode.addComponent(Canvas);
        cnv.cameraComponent = cam;

        // 面板容器：贴左下、宽度固定、高度按行数增长（anchor(0,0) → 向上撑开）
        const root = new Node('Container');
        root.layer = Layers.Enum.PROFILER;
        root.parent = cnvNode;
        const rootUT = root.addComponent(UITransform);
        rootUT.setContentSize(PANEL_W, PAD * 2 + LINE_H);
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
        richNode.layer = Layers.Enum.PROFILER;
        richNode.parent = root;
        const richUT = richNode.addComponent(UITransform);
        richUT.setContentSize(PANEL_W - PAD * 2, LINE_H);
        richUT.setAnchorPoint(0, 0);
        // 整体下移 LEADING，使最后一行字形底部对齐到 y=PAD（与顶部 PAD 视觉对称）
        richNode.setPosition(PAD, PAD - LEADING, 0);
        const rich = richNode.addComponent(RichText);
        rich.fontSize = FONT;
        rich.lineHeight = LINE_H;
        // 不设 maxWidth：禁止自动换行，每条 Row 一行；容器宽度恒定 PANEL_W，文本溢出截断（实际不会超）
        rich.horizontalAlign = HorizontalTextAlignment.LEFT;
        rich.string = '';

        // 输入透明：RichText.onEnable 会注册 TOUCH_END listener 处理 <on click> 标签，
        // 在 Cocos 3.x 输入分发里"命中即吃掉"，会挡住下层按钮。覆写 hitTest 返回 false 让命中测试跳过本面板
        const noHit = (): boolean => false;
        rootUT.hitTest = noHit;
        richUT.hitTest = noHit;

        // 一次性 addChild 入场景：所有组件 onLoad/onEnable 一起触发，Canvas 拿到已绑定的 cameraComponent 自动 alignWithScreen
        scene.addChild(cnvNode);
        // 跨场景持久：标记为 persist root node，切场景时引擎不会销毁本节点，无需手动重挂
        director.addPersistRootNode(cnvNode);
        widget.updateAlignment();

        this._cnvRoot = cnvNode;
        this._root = root;
        this._rich = rich;
        this._bg = bg;
        this._resize(LINE_H);
    }

    public hide(): void {
        if (this._cnvRoot && this._cnvRoot.isValid) {
            // persist root 列表持有节点引用，destroy 前先移除避免引用泄漏
            director.removePersistRootNode(this._cnvRoot);
            this._cnvRoot.destroy();
        }
        this._cnvRoot = null;
        this._root = null;
        this._rich = null;
        this._bg = null;
    }

    /** 把 Row[] 渲染成富文本：每行包 color 标签（warn 红、正常白）。宽度恒定，高度按行数撑开。 */
    public render(rows: Row[]): void {
        if (!this._rich || !this._rich.isValid) return;
        const lines: string[] = [];
        rows.forEach((r) => {
            const color = r.warn ? COLOR_WARN : COLOR_NORMAL;
            lines.push(`<color=#${color}>${r.text}</color>`);
        });
        this._rich.string = lines.join('\n');

        // RichText.string setter 内部同步执行 layout，把 node UITransform 调到实际渲染尺寸；只取高度
        const richUT = this._rich.node.getComponent(UITransform);
        const richH = richUT == null ? LINE_H : richUT.contentSize.height;
        this._resize(richH);
    }

    /** 按行数撑开 root 高度 + 重绘背景。宽度恒定 PANEL_W，anchor(0,0) + Widget bottom-left 保证向上展开。 */
    private _resize(richHeight: number): void {
        if (!this._root || !this._root.isValid) return;
        const w = PANEL_W;
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
