import { BlockInputEvents, Button, Camera, Color, director, Director, EventTouch, Graphics, Label, Mask, Node, screen, ScrollView, Touch, UITransform, Vec2, Vec3, view } from 'cc';
import { ScreenLog } from '../core/ScreenLog';
import { ScreenLogDefine as D } from '../core/ScreenLogDefine';
import { ScreenLogViewport } from '../core/ScreenLogViewport';

/** 默认穿透的悬浮日志；查看模式使用 Cocos 滚动和裁剪，仅复用可见文字行。 */
export class ScreenLogPanel {
    private _node: Node;
    private _header: Label;
    private _modeLabel: Label;
    private _modeNode: Node;
    private _minimizeNode: Node;
    private _restoreNode: Node;
    private _dragHandle: Node;
    private _resizeHandle: Node;
    private _sizeHint: Label;
    private _viewport: Node;
    private _content: Node;
    private _scroll: ScrollView;
    private _block: BlockInputEvents;
    private _bar: Graphics;
    /** 可见日志块共用一个绘制节点，背景不随历史条数增长。 */
    private _rowBackground: Graphics;
    private _camera: Camera;
    private readonly _model = new ScreenLogViewport();
    private readonly _rowPool: Label[] = [];
    private readonly _copyButtons: Node[] = [];
    private readonly _copyTexts: string[] = [];
    private readonly _copyPending: string[] = [];
    private _interactive = false;
    private _minimized = false;
    private _syncingScroll = false;
    private _lastState = '';
    private _drawnRows: D.Row[] = [];
    private _drawnStart = -1;
    private _drawnWidth = 0;
    private _drawnInteractive = false;
    private _width = 0;
    private _height = 0;
    private _viewHeight = 0;
    private _screenWidth = 0;
    private _screenHeight = 0;
    /** 展开面板的屏幕归一化坐标，关闭重开沿用，转屏后约束到新可见区域。 */
    private readonly _position = new Vec2(0.02, 0.93);
    /** 首次收起沿用面板位置，此后独立保存，避免展开时的边界约束把入口挤回左侧。 */
    private _minimizedPosition: Vec2;
    private readonly _dragOffset = new Vec2();
    private readonly _dragStart = new Vec2();
    private _dragMoved = false;
    private _dragTouch: Touch;
    /** 用户选定的逻辑尺寸；零表示沿用默认尺寸，关闭与收起时保留。 */
    private readonly _preferredSize = new Vec2();
    private readonly _resizeStart = new Vec2();
    private readonly _resizeStartSize = new Vec2();
    private _resizeTouch: Touch;
    private readonly _colors = {
        log: new Color(...D.LEVEL_COLORS.log),
        info: new Color(...D.LEVEL_COLORS.info),
        debug: new Color(...D.LEVEL_COLORS.debug),
        warn: new Color(...D.LEVEL_COLORS.warn),
        error: new Color(...D.LEVEL_COLORS.error),
    };
    /** 普通日志头部使用蓝色，正文继续使用等级颜色。 */
    private readonly _entryHeaderColor = new Color(151, 198, 239, 255);
    /** 不透明日志底色避免游戏画面干扰文字。 */
    private readonly _entryBackgrounds = [new Color(17, 24, 34, 255), new Color(25, 34, 47, 255)];
    private readonly _entryHeaderBackground = new Color(35, 49, 67, 255);
    private readonly _entryDividerColor = new Color(77, 97, 121, 255);

    /** 退出或宿主节点销毁时由调用方统一停掉各日志来源。 */
    constructor(
        private readonly _log: ScreenLog,
        private readonly _onClosed: () => void,
        private readonly _onCopy: (text: string) => void = null,
    ) {}

    get visible(): boolean { return !!this._node && this._node.isValid; }

    /** 正文默认穿透；标题栏拖动，右上角按钮切换查看模式。 */
    show(host: Node, camera: Camera): void {
        if (this.visible) return;
        const node = this._createNode('ScreenLogPanel', host);
        node.active = false;
        node.addComponent(Graphics);
        this._node = node;
        this._camera = camera;
        this._dragHandle = this._createNode('DragHandle', node);
        this._dragHandle.on(Node.EventType.TOUCH_START, this._onDragStart, this);
        this._dragHandle.on(Node.EventType.TOUCH_MOVE, this._onDragMove, this);
        this._dragHandle.on(Node.EventType.TOUCH_END, this._onDragEnd, this);
        this._dragHandle.on(Node.EventType.TOUCH_CANCEL, this._onDragEnd, this);
        this._header = this._createLabel('Header', node);
        this._header.string = '屏幕日志';
        this._modeNode = this._createNode('Mode', node);
        this._modeNode.addComponent(Graphics);
        this._modeLabel = this._createLabel('ModeLabel', this._modeNode);
        this._modeNode.addComponent(Button).transition = Button.Transition.NONE;
        this._modeNode.on(Button.EventType.CLICK, this._toggleInteraction, this);
        this._minimizeNode = this._createNode('Minimize', node);
        const minimizeBg = this._minimizeNode.addComponent(Graphics);
        minimizeBg.fillColor = new Color(60, 70, 85, 255);
        minimizeBg.rect(0, -32, 60, 32); minimizeBg.fill();
        this._minimizeNode.getComponent(UITransform).setContentSize(60, 32);
        const minimizeLabel = this._createLabel('MinimizeLabel', this._minimizeNode);
        minimizeLabel.string = '收起';
        minimizeLabel.node.setPosition(10, -3);
        minimizeLabel.node.getComponent(UITransform).setContentSize(50, D.ROW_HEIGHT);
        this._minimizeNode.addComponent(Button).transition = Button.Transition.NONE;
        this._minimizeNode.on(Button.EventType.CLICK, this._minimize, this);
        this._restoreNode = this._createNode('Restore', node);
        this._restoreNode.getComponent(UITransform).setContentSize(D.MINIMIZED_WIDTH, D.MINIMIZED_HEIGHT);
        this._restoreNode.on(Node.EventType.TOUCH_START, this._onDragStart, this);
        this._restoreNode.on(Node.EventType.TOUCH_MOVE, this._onDragMove, this);
        this._restoreNode.on(Node.EventType.TOUCH_END, this._onDragEnd, this);
        this._restoreNode.on(Node.EventType.TOUCH_CANCEL, this._onDragEnd, this);
        const restoreLabel = this._createLabel('RestoreLabel', this._restoreNode);
        restoreLabel.string = '日志 +';
        restoreLabel.node.setPosition(12, -9);
        restoreLabel.node.getComponent(UITransform).setContentSize(D.MINIMIZED_WIDTH - 20, D.ROW_HEIGHT);

        this._viewport = this._createNode('Viewport', node);
        this._viewport.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
        const viewportTransform = this._viewport.getComponent(UITransform);
        const hitTest = viewportTransform.hitTest;
        // 保留 ScrollView 的尺寸监听；穿透模式只退出命中检测，避免滚动边界停止更新。
        viewportTransform.hitTest = (point, windowId) => !this._minimized && this._interactive && hitTest.call(viewportTransform, point, windowId);
        this._content = this._createNode('Content', this._viewport);
        this._rowBackground = this._createNode('RowBackground', this._content).addComponent(Graphics);
        this._scroll = this._viewport.addComponent(ScrollView);
        this._scroll.content = this._content;
        this._scroll.horizontal = false;
        this._scroll.vertical = true;
        this._scroll.elastic = false;
        this._scroll.inertia = true;
        this._block = this._viewport.addComponent(BlockInputEvents);
        this._block.enabled = false;
        this._viewport.on(ScrollView.EventType.SCROLLING, this._onScrolling, this);
        this._bar = this._createNode('ScrollBar', node).addComponent(Graphics);
        this._sizeHint = this._createLabel('SizeHint', node);
        this._sizeHint.string = '拖动右下角调整大小';
        this._sizeHint.fontSize = D.ENTRY_HEADER_FONT_SIZE;
        this._sizeHint.color = new Color(151, 171, 194, 255);
        this._resizeHandle = this._createNode('ResizeHandle', node);
        this._resizeHandle.getComponent(UITransform).setContentSize(D.RESIZE_HANDLE_SIZE, D.RESIZE_HANDLE_SIZE);
        const resizeBg = this._resizeHandle.addComponent(Graphics);
        resizeBg.fillColor = new Color(45, 88, 125, 255);
        resizeBg.rect(0, -D.RESIZE_HANDLE_SIZE, D.RESIZE_HANDLE_SIZE, D.RESIZE_HANDLE_SIZE);
        resizeBg.fill();
        const resizeIcon = this._createLabel('ResizeIcon', this._resizeHandle);
        resizeIcon.string = '↘';
        resizeIcon.fontSize = 26;
        resizeIcon.node.setPosition(6, -3);
        resizeIcon.node.getComponent(UITransform).setContentSize(D.RESIZE_HANDLE_SIZE - 8, D.RESIZE_HANDLE_SIZE - 4);
        this._resizeHandle.on(Node.EventType.TOUCH_START, this._onResizeStart, this);
        this._resizeHandle.on(Node.EventType.TOUCH_MOVE, this._onResizeMove, this);
        this._resizeHandle.on(Node.EventType.TOUCH_END, this._onResizeEnd, this);
        this._resizeHandle.on(Node.EventType.TOUCH_CANCEL, this._onResizeEnd, this);
        this._interactive = false;
        this._minimized = false;
        this._width = this._height = 0;
        this._lastState = '';
        this._model.clear();
        node.active = true;
        director.on(Director.EVENT_AFTER_UPDATE, this._render, this);
        this._render();
    }

    /** 关闭时销毁整个节点池和滚动监听，不保留历史节点或业务引用。 */
    hide(): void {
        director.off(Director.EVENT_AFTER_UPDATE, this._render, this);
        if (this.visible) this._node.destroy();
        this._node = null;
        this._header = this._modeLabel = null;
        this._modeNode = this._viewport = this._content = null;
        this._minimizeNode = this._restoreNode = null;
        this._minimized = false;
        this._dragHandle = null;
        this._dragTouch = null;
        this._resizeHandle = null;
        this._sizeHint = null;
        this._resizeTouch = null;
        this._scroll = null;
        this._block = null;
        this._bar = null;
        this._rowBackground = null;
        this._camera = null;
        this._rowPool.length = 0;
        this._drawnRows = [];
        this._drawnStart = -1;
        this._copyButtons.length = 0;
        this._copyTexts.length = 0;
        this._copyPending.length = 0;
        this._model.clear();
        this._onClosed();
    }

    private _createNode(name: string, parent: Node): Node {
        const node = new Node(name);
        node.layer = parent.layer;
        node.parent = parent;
        node.addComponent(UITransform).setAnchorPoint(0, 1);
        return node;
    }

    private _createLabel(name: string, parent: Node): Label {
        const label = this._createNode(name, parent).addComponent(Label);
        label.useSystemFont = true;
        label.fontFamily = 'monospace';
        label.fontSize = D.FONT_SIZE;
        label.lineHeight = D.ROW_HEIGHT;
        label.horizontalAlign = Label.HorizontalAlign.LEFT;
        label.verticalAlign = Label.VerticalAlign.TOP;
        label.overflow = Label.Overflow.CLAMP;
        label.enableWrapText = false;
        label.color = Color.WHITE;
        return label;
    }

    private _toggleInteraction(): void {
        this._interactive = !this._interactive;
        this._scroll.stopAutoScroll();
        this._block.enabled = this._interactive;
        if (!this._interactive) {
            this._model.scroll(this._model.maxOffset);
            this._setScrollOffset();
        }
        this._renderRows();
    }

    private _minimize(): void {
        this._setMinimized(true);
    }

    /** 收起仅暂停绘制，日志采集、阅读锚点和行节点池保持原样。 */
    private _setMinimized(minimized: boolean): void {
        this._scroll.stopAutoScroll();
        if (minimized && !this._minimizedPosition) {
            this._minimizedPosition = new Vec2(this._position.x, this._position.y);
        }
        this._minimized = minimized;
        this._copyPending.fill('');
        this._dragTouch = null;
        this._resizeTouch = null;
        this._applyPresentation();
        if (!minimized) {
            this._lastState = '';
            this._render();
        }
    }

    private _applyPresentation(): void {
        const expanded = !this._minimized;
        // ScrollView 重新启用会校正边界，不能让这次程序性滚动改写历史阅读锚点。
        const wasSyncing = this._syncingScroll;
        this._syncingScroll = true;
        for (const node of [this._dragHandle, this._header.node, this._modeNode,
            this._minimizeNode, this._viewport, this._bar.node, this._resizeHandle, this._sizeHint.node]) node.active = expanded;
        this._syncingScroll = wasSyncing;
        this._restoreNode.active = this._minimized;
        this._block.enabled = expanded && this._interactive;
        const width = this._minimized ? D.MINIMIZED_WIDTH : this._width;
        const height = this._minimized ? D.MINIMIZED_HEIGHT : this._height;
        this._node.getComponent(UITransform).setContentSize(width, height);
        const bg = this._node.getComponent(Graphics);
        bg.clear();
        bg.fillColor = this._minimized ? new Color(45, 88, 125, 240) : new Color(8, 13, 21, 245);
        bg.rect(0, -height, width, height); bg.fill();
        this._placePanel();
    }

    private _onScrolling(): void {
        if (this._syncingScroll || this._minimized || !this.visible) return;
        this._model.scroll(this._scroll.getScrollOffset().y);
        this._renderRows();
    }

    private get _activePosition(): Vec2 {
        return this._minimized ? this._minimizedPosition : this._position;
    }

    private _onDragStart(event: EventTouch): void {
        event.propagationStopped = true;
        if (this._dragTouch || this._resizeTouch || !event.touch) return;
        this._dragTouch = event.touch;
        this._scroll.stopAutoScroll();
        const point = event.getLocation();
        this._dragStart.set(point.x, point.y);
        this._dragMoved = false;
        const size = screen.windowSize;
        const position = this._activePosition;
        this._dragOffset.set(position.x - point.x / size.width, position.y - point.y / size.height);
    }

    private _onDragMove(event: EventTouch): void {
        event.propagationStopped = true;
        if (!this._dragTouch || event.touch !== this._dragTouch) return;
        const point = event.getLocation();
        const size = screen.windowSize;
        const visible = view.getVisibleSize();
        const dx = (point.x - this._dragStart.x) * visible.width / size.width;
        const dy = (point.y - this._dragStart.y) * visible.height / size.height;
        if (dx * dx + dy * dy >= D.DRAG_THRESHOLD * D.DRAG_THRESHOLD) this._dragMoved = true;
        if (!this._dragMoved) return;
        this._activePosition.set(point.x / size.width + this._dragOffset.x, point.y / size.height + this._dragOffset.y);
        this._placePanel();
    }

    private _onDragEnd(event: EventTouch): void {
        event.propagationStopped = true;
        if (event.touch !== this._dragTouch) return;
        const restore = this._minimized && !this._dragMoved
            && event.getEventCode() === Node.EventType.TOUCH_END
            && this._restoreNode.getComponent(UITransform).hitTest(event.getLocation(), event.windowId);
        this._dragTouch = null;
        if (restore) this._setMinimized(false);
    }

    /** 缩放柄独立接管一根手指；正文处于穿透模式时也不能把该手势传给游戏。 */
    private _onResizeStart(event: EventTouch): void {
        event.propagationStopped = true;
        if (this._minimized || this._dragTouch || this._resizeTouch || !event.touch) return;
        this._resizeTouch = event.touch;
        this._scroll.stopAutoScroll();
        const point = event.getLocation();
        this._resizeStart.set(point.x, point.y);
        this._resizeStartSize.set(this._width, this._height);
    }

    /** 固定左上角调整宽高；只更新目标尺寸，排版交给每帧 render 合并执行。 */
    private _onResizeMove(event: EventTouch): void {
        event.propagationStopped = true;
        if (!this._resizeTouch || event.touch !== this._resizeTouch) return;
        const point = event.getLocation();
        const visible = view.getVisibleSize();
        const screenSize = screen.windowSize;
        const width = this._resizeStartSize.x + (point.x - this._resizeStart.x) * visible.width / screenSize.width;
        const height = this._resizeStartSize.y - (point.y - this._resizeStart.y) * visible.height / screenSize.height;
        const maxWidth = Math.max(1, (1 - this._position.x) * visible.width - 4);
        const maxHeight = Math.max(1, this._position.y * visible.height - 4);
        this._preferredSize.set(
            Math.max(Math.min(D.MIN_PANEL_WIDTH, maxWidth), Math.min(maxWidth, width)),
            Math.max(Math.min(D.MIN_PANEL_HEIGHT, maxHeight), Math.min(maxHeight, height)),
        );
    }

    private _onResizeEnd(event: EventTouch): void {
        event.propagationStopped = true;
        if (event.touch === this._resizeTouch) this._resizeTouch = null;
    }

    /** 保留整个面板和标题栏在屏幕内，避免拖出后无法再次操作。 */
    private _placePanel(): void {
        const visible = view.getVisibleSize();
        const size = screen.windowSize;
        const marginX = 4 / visible.width;
        const marginY = 4 / visible.height;
        const width = this._minimized ? D.MINIMIZED_WIDTH : this._width;
        const height = this._minimized ? D.MINIMIZED_HEIGHT : this._height;
        const maxX = Math.max(marginX, 1 - width / visible.width - marginX);
        const minY = Math.min(1 - marginY, height / visible.height + marginY);
        const position = this._activePosition;
        position.x = Math.max(marginX, Math.min(maxX, position.x));
        position.y = Math.max(minY, Math.min(1 - marginY, position.y));
        this._node.setWorldPosition(this._camera.screenToWorld(new Vec3(size.width * position.x, size.height * position.y, 0)));
    }

    /** 日志追加每帧最多重排一次，滚动仅更新可见行；阅读历史时保持锚点。 */
    private _render(): void {
        if (!this.visible || !this._camera.isValid) { this.hide(); return; }
        const visible = view.getVisibleSize();
        const screenSize = screen.windowSize;
        const maxWidth = Math.max(1, visible.width - 8);
        const maxHeight = Math.max(1, visible.height - 8);
        const width = Math.min(maxWidth, Math.max(D.MIN_PANEL_WIDTH, this._preferredSize.x || visible.width - 24));
        const height = Math.min(maxHeight, Math.max(D.MIN_PANEL_HEIGHT, this._preferredSize.y || Math.min(510, visible.height * 0.6)));
        const resized = width !== this._width || height !== this._height
            || screenSize.width !== this._screenWidth || screenSize.height !== this._screenHeight;
        if (resized) this._resize(width, height);
        if (this._minimized) return;
        const state = `${this._log.revision}/${this._log.source}/${this._log.severity}`;
        if (!resized && state === this._lastState) return;
        this._lastState = state;
        // ASCII 留足字宽余量；中文按双宽换行，避免长日志被缩成小字。
        const columns = Math.floor((width - 30 - D.ENTRY_INSET * 3) / (D.FONT_SIZE * 0.65));
        this._model.update(this._log, columns, this._viewHeight);
        this._syncingScroll = true;
        this._content.getComponent(UITransform).setContentSize(width - 30, this._model.contentHeight);
        this._rowBackground.node.getComponent(UITransform).setContentSize(width - 30, this._model.contentHeight);
        this._syncingScroll = false;
        this._setScrollOffset();
        this._renderRows();
    }

    private _resize(width: number, height: number): void {
        this._syncingScroll = true;
        this._width = width;
        this._height = height;
        this._viewHeight = Math.max(D.ROW_HEIGHT, height - D.HEADER_HEIGHT - D.RESIZE_HANDLE_SIZE - 4);
        const size = screen.windowSize;
        if (this._screenWidth !== size.width || this._screenHeight !== size.height) this._resizeTouch = null;
        this._screenWidth = size.width;
        this._screenHeight = size.height;
        this._dragTouch = null;
        this._applyPresentation();
        this._dragHandle.getComponent(UITransform).setContentSize(Math.max(0, width - 230), D.HEADER_HEIGHT);
        this._header.node.setPosition(10, -10);
        this._header.node.getComponent(UITransform).setContentSize(Math.max(0, width - 240), D.ROW_HEIGHT);
        this._modeNode.setPosition(width - 220, -8);
        this._minimizeNode.setPosition(width - 70, -8);
        this._modeNode.getComponent(UITransform).setContentSize(140, 32);
        const mode = this._modeNode.getComponent(Graphics);
        mode.clear(); mode.fillColor = new Color(45, 88, 125, 255); mode.rect(0, -32, 140, 32); mode.fill();
        this._modeLabel.node.setPosition(12, -3);
        this._modeLabel.node.getComponent(UITransform).setContentSize(124, D.ROW_HEIGHT);
        this._viewport.setPosition(10, -D.HEADER_HEIGHT);
        this._viewport.getComponent(UITransform).setContentSize(width - 30, this._viewHeight);
        this._bar.node.setPosition(width - 10, -D.HEADER_HEIGHT);
        this._resizeHandle.setPosition(width - D.RESIZE_HANDLE_SIZE, -height + D.RESIZE_HANDLE_SIZE);
        this._sizeHint.node.setPosition(10, -height + D.RESIZE_HANDLE_SIZE - 7);
        this._sizeHint.node.getComponent(UITransform).setContentSize(width - D.RESIZE_HANDLE_SIZE - 24, D.ROW_HEIGHT);
        this._syncingScroll = false;
    }

    private _setScrollOffset(): void {
        if (Math.abs(this._scroll.getScrollOffset().y - this._model.offset) < 0.1) return;
        this._syncingScroll = true;
        this._scroll.scrollToOffset(new Vec2(0, this._model.offset), 0);
        this._syncingScroll = false;
    }

    private _renderRows(): void {
        if (this._minimized) return;
        const range = this._model.range();
        const count = range.end - range.start;
        const unchanged = this._drawnStart === range.start && this._drawnRows.length === count
            && this._drawnWidth === this._width && this._drawnInteractive === this._interactive
            && this._drawnRows.every((row, index) => row === this._model.rows[range.start + index]);
        if (unchanged) { this._renderScrollBar(); return; }
        this._drawnStart = range.start;
        this._drawnWidth = this._width;
        this._drawnInteractive = this._interactive;
        this._drawnRows = this._model.rows.slice(range.start, range.end);
        const background = this._rowBackground;
        background.clear();
        let copyCount = 0;
        while (this._rowPool.length < count) this._rowPool.push(this._createLabel('LogRow', this._content));
        for (let i = 0; i < this._rowPool.length; i++) {
            const label = this._rowPool[i];
            label.node.active = i < count;
            if (i >= count) {
                label.string = '';
                continue;
            }
            const index = range.start + i;
            const row = this._model.rows[index];
            const header = row.kind === 'header';
            const inset = D.ENTRY_INSET * (header ? 1 : 2);
            const copyText = header && this._interactive && this._onCopy ? row.copyText : '';
            const y = -index * D.ROW_HEIGHT;
            if (copyText) {
                if (copyCount === this._copyButtons.length) this._createCopyButton();
                if (this._copyTexts[copyCount] !== copyText) this._copyPending[copyCount] = '';
                this._copyTexts[copyCount] = copyText;
                const button = this._copyButtons[copyCount++];
                button.active = true;
                button.setPosition(this._width - 30 - D.COPY_BUTTON_WIDTH, y);
            }
            const accent = row.level === 'log' ? this._entryHeaderColor : this._colors[row.level];
            background.fillColor = header ? this._entryHeaderBackground : this._entryBackgrounds[row.band];
            background.rect(0, y - D.ROW_HEIGHT, this._width - 30, D.ROW_HEIGHT);
            background.fill();
            background.fillColor = accent;
            background.rect(0, y - D.ROW_HEIGHT, 3, D.ROW_HEIGHT);
            background.fill();
            if (header) {
                background.fillColor = this._entryDividerColor;
                background.rect(0, y - 1, this._width - 30, 1);
                background.fill();
            }
            label.node.setPosition(inset, y - (header ? 4 : 1));
            label.node.getComponent(UITransform).setContentSize(
                this._width - 30 - inset - D.ENTRY_INSET - (copyText ? D.COPY_BUTTON_WIDTH : 0), D.ROW_HEIGHT,
            );
            if (label.string !== row.text) label.string = row.text;
            label.fontSize = header ? D.ENTRY_HEADER_FONT_SIZE : D.FONT_SIZE;
            label.isBold = header;
            label.color = header ? accent : this._colors[row.level];
        }
        for (let i = copyCount; i < this._copyButtons.length; i++) {
            this._copyButtons[i].active = false;
            this._copyTexts[i] = this._copyPending[i] = '';
        }
        this._modeLabel.string = this._interactive ? '穿透游戏' : '查看日志';
        this._renderScrollBar();
    }

    /** 行范围未改变时，滚动只需移动内容和更新滚动条。 */
    private _renderScrollBar(): void {
        this._bar.clear();
        if (this._model.maxOffset > 0) {
            const thumb = Math.max(18, this._viewHeight * this._viewHeight / this._model.contentHeight);
            const y = (this._viewHeight - thumb) * this._model.offset / this._model.maxOffset;
            this._bar.fillColor = new Color(180, 195, 210, 220);
            this._bar.rect(0, -y - thumb, 4, thumb);
            this._bar.fill();
        }
    }

    /** 按可见行复用按钮；换行、筛选或滚动复用后取消旧按压，避免复制另一条记录。 */
    private _createCopyButton(): void {
        const index = this._copyButtons.length;
        const button = this._createNode('CopyLog', this._content);
        button.getComponent(UITransform).setContentSize(D.COPY_BUTTON_WIDTH, D.ROW_HEIGHT);
        const background = button.addComponent(Graphics);
        background.fillColor = new Color(45, 88, 125, 255);
        background.rect(0, -D.ROW_HEIGHT, D.COPY_BUTTON_WIDTH, D.ROW_HEIGHT);
        background.fill();
        const text = this._createLabel('CopyLabel', button);
        text.string = '复制';
        text.fontSize = D.ENTRY_HEADER_FONT_SIZE;
        text.node.setPosition(12, -4);
        text.node.getComponent(UITransform).setContentSize(D.COPY_BUTTON_WIDTH - 12, D.ROW_HEIGHT);
        button.addComponent(Button).transition = Button.Transition.NONE;
        button.on(Node.EventType.TOUCH_START, () => { this._copyPending[index] = this._copyTexts[index]; }, this);
        button.on(Node.EventType.TOUCH_CANCEL, () => { this._copyPending[index] = ''; }, this);
        button.on(Button.EventType.CLICK, () => {
            const snapshot = this._copyPending[index];
            this._copyPending[index] = '';
            if (snapshot && snapshot === this._copyTexts[index] && this._interactive && !this._minimized) {
                this._onCopy(snapshot);
            }
        }, this);
        this._copyButtons.push(button);
        this._copyTexts.push('');
        this._copyPending.push('');
    }
}
