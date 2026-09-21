const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/** 每次使用独立控制台和模块，避免测试本身的输出被观察。 */
function setup() {
    const delivered = [], cache = new Map();
    const console = Object.fromEntries(['log', 'warn', 'error', 'debug', 'info'].map(level => [level,
        function (...args) { delivered.push({ level, args, receiver: this }); }]));
    const original = { ...console };
    const scope = vm.createContext({ console, Date, Set, Map });
    function load(name) {
        if (cache.has(name)) return cache.get(name);
        const filename = path.join(__dirname, '../lib/core', name + '.ts');
        const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        const module = { exports: {} };
        const fn = vm.runInContext('(function(require,module,exports){' + output + '\n})', scope);
        fn(dep => load(dep.slice(2)), module, module.exports);
        cache.set(name, module.exports);
        return module.exports;
    }
    const { ScreenLog } = load('ScreenLog');
    return { log: new ScreenLog(), ScreenLog, console, original, delivered,
        ScreenLogViewport: load('ScreenLogViewport').ScreenLogViewport, D: load('ScreenLogDefine').ScreenLogDefine };
}

test('默认关闭，开启不叠加，保留各等级、参数引用、this，停止后恢复', () => {
    const s = setup(), payload = { id: 123 };
    s.log.append('custom', 'warn', '忽略'); assert.equal(s.log.recent().length, 0);
    s.log.start(); s.log.start();
    for (const level of Object.keys(s.original)) s.console[level]('模块', payload);
    assert.equal(s.delivered.length, 5); assert.equal(s.log.recent().length, 5);
    for (const event of s.delivered) {
        assert.equal(event.args[1], payload); assert.equal(event.receiver, s.console);
    }
    s.log.stop();
    for (const key of Object.keys(s.original)) assert.equal(s.console[key], s.original[key]);
    s.console.log('关闭后'); assert.equal(s.delivered.length, 6); assert.equal(s.log.recent().length, 0);
});

test('来源与级别只筛选显示，暂停期间不格式化参数也不阻断输出', () => {
    const s = setup(); s.log.start();
    s.console.log('普通'); s.console.warn('警告'); s.console.error('错误'); s.log.append('touch', 'log', 'START');
    s.log.source = 'touch'; assert.equal(s.log.recent().length, 1);
    s.log.source = ''; s.log.severity = 'warning'; assert.equal(s.log.recent().length, 2);
    s.log.severity = 'error'; assert.equal(s.log.recent()[0].level, 'error');
    s.log.paused = true;
    const proxy = new Proxy({}, { ownKeys() { throw new Error('暂停不应展开'); } });
    s.console.log(proxy); s.log.append('touch', 'log', 'END');
    assert.equal(s.delivered.length, 4);
    s.log.severity = 'all'; assert.equal(s.log.recent().length, 4);
});

test('对象枚举或过滤器抛错不影响业务，后续日志仍可采集', () => {
    const s = setup(); s.log.start();
    const ownKeysError = new Proxy({}, { ownKeys() { throw Error('ownKeys'); } });
    const descriptorError = new Proxy({ id: 1 }, {
        getOwnPropertyDescriptor() { throw Error('descriptor'); },
    });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [ownKeysError, descriptorError, revoked.proxy]) {
        assert.doesNotThrow(() => s.console.log(value));
    }
    assert.equal(s.delivered.length, 3); assert.equal(s.log.recent().length, 0);
    s.console.log('恢复'); assert.equal(s.log.recent()[0].text, '恢复');
    s.log.stop();
    s.log.start((level, args) => {
        if (args[0] === '失败') throw Error('filter');
        return args[0] !== '忽略';
    });
    assert.doesNotThrow(() => s.console.warn('失败'));
    s.console.log('忽略'); s.console.info('继续');
    assert.equal(s.delivered.length, 7);
    assert.equal(s.log.recent().length, 1); assert.equal(s.log.recent()[0].text, '继续');
});

test('过滤与格式化期间再次输出只调用原控制台，不递归采集', () => {
    const s = setup(); let filtered = 0, enumerated = 0;
    s.log.start(() => { filtered++; s.console.warn('过滤器内部'); return true; });
    const value = new Proxy({ id: 1 }, {
        ownKeys(target) {
            enumerated++;
            s.console.error(value);
            return Reflect.ownKeys(target);
        },
    });
    s.console.log(value);
    assert.equal(filtered, 1); assert.equal(enumerated, 1);
    assert.equal(s.delivered.length, 3); assert.equal(s.log.recent().length, 1);
    assert.ok(s.log.recent()[0].text.includes('id: 1'));
    s.console.info('后续');
    assert.equal(filtered, 2); assert.equal(s.log.recent().length, 2);
});

test('原控制台自身抛错仍按原语义传给调用方', () => {
    const s = setup(), expected = Error('原控制台错误');
    s.console.log = () => { throw expected; };
    s.log.start();
    assert.throws(() => s.console.log('原输出失败'), error => error === expected);
    assert.equal(s.log.recent().length, 0);
    s.console.warn('其他等级仍可用'); assert.equal(s.log.recent().length, 1);
});

test('MOVE 分阶段合并，关键事件保留，所有可见记录按统一序号递增', () => {
    const s = setup(); s.log.start();
    s.log.append('touch', 'log', 'START');
    for (let i = 0; i < 100; i++) {
        s.log.append('touch', 'log', 'MOVE ' + i, 'engine-move');
        s.log.append('touch', 'log', 'RAW ' + i, 'raw-move');
    }
    s.console.warn('test'); s.log.append('touch', 'log', 'END');
    const entries = s.log.recent(); assert.equal(entries.length, 5); assert.equal(entries[0].text, 'START');
    assert.equal(entries[1].text, 'MOVE 99'); assert.equal(entries[2].text, 'RAW 99');
    assert.ok(entries.every((e, i) => i === 0 || e.sequence > entries[i - 1].sequence));
});

test('缓冲和详情有界，清空重置时序和首个异常，显示过滤保留数据', () => {
    const s = setup(); s.log.start();
    for (let i = 0; i < 400; i++) s.log.append('console', 'log', String(i));
    assert.equal(s.log.recent(999).length, 200); assert.equal(s.log.recent(999)[0].text, '200');
    s.log.pinDetail('touch', '首次'); s.log.pinDetail('touch', '不可覆盖');
    assert.ok(s.log.getDetail().includes('首次'));
    s.log.source = 'console'; assert.equal(s.log.getDetail(), '');
    s.log.clear(); assert.equal(s.log.hasDetail('touch'), false);
    s.console.log('重置'); assert.equal(s.log.recent()[0].sequence, 1);
    s.log.stop(); s.log.start(); assert.equal(s.log.recent().length, 0);
});

test('格式化循环、Error 和大对象；不执行 getter、toJSON 或 toString', () => {
    const s = setup();
    const value = { n: 3, big: 10n, fn() {}, get dangerous() { throw Error('getter'); },
        toJSON() { throw Error('toJSON'); }, toString() { throw Error('toString'); } };
    value.self = value;
    const text = s.ScreenLog.format([value, new Error('测试错误')]);
    assert.ok(text.includes('[getter]')); assert.ok(text.includes('[重复引用]')); assert.ok(text.includes('测试错误'));
    assert.ok(s.ScreenLog.format([Array.from({ length: 10000 }, () => 'x'.repeat(5000))]).length <= 2000);
});

test('宿主注入过滤规则，原控制台仍输出，后续替换不被卸载覆盖', () => {
    const s = setup();
    let muted = true;
    s.log.start((level, args) => level === 'error' || !muted || args[0] !== '静音组');
    s.console.log('静音组'); assert.equal(s.log.recent().length, 0);
    assert.equal(s.delivered.length, 1);
    s.console.error('静音组'); assert.equal(s.log.recent().length, 1);
    muted = false; s.console.warn('静音组'); assert.equal(s.log.recent().length, 2);
    const replacement = () => {};
    s.console.log = replacement; s.log.stop(); assert.equal(s.console.log, replacement);
});

test('外部保留旧包装时，关闭和重开不覆盖外部入口、不递归或重复采集', () => {
    const s = setup(); s.log.start(); const old = s.console.log;
    const external = (...args) => old.apply(s.console, args);
    s.console.log = external; s.log.stop(); assert.equal(s.console.log, external);
    s.log.start(); s.console.log('一次');
    assert.equal(s.delivered.length, 1); assert.equal(s.log.recent().length, 1);
    s.log.stop(); assert.equal(s.console.log, external);
});

/** 最小 Cocos 宿主验证节点复用和模式契约，不冒充真机触摸和裁剪。 */
function panelSetup(log, onCopy = null) {
    class UITransform {
        setAnchorPoint() {}
        setContentSize(width, height) { Object.assign(this, { width, height }); }
        hitTest() { return true; }
    }
    class Graphics { clears = 0; clear() { this.clears++; } rect() {} fill() {} }
    class Label {}
    Label.HorizontalAlign = { LEFT: 0 }; Label.VerticalAlign = { TOP: 0 }; Label.Overflow = { CLAMP: 0 };
    class Mask {} Mask.Type = { GRAPHICS_RECT: 0 };
    class Button {} Button.Transition = { NONE: 0 }; Button.EventType = { CLICK: 'click' };
    class BlockInputEvents { enabled = true; }
    class ScrollView {
        offset = 0;
        getScrollOffset() { return { y: this.offset }; }
        stopAutoScroll() {}
        scrollToOffset(point) { this.offset = point.y; this.node.emit('scrolling'); }
    }
    ScrollView.EventType = { SCROLLING: 'scrolling' };
    const nodes = [], listeners = new Set();
    class Node {
        constructor(name) {
            Object.assign(this, { name, isValid: true, active: true, components: new Map(), handlers: [], children: [] });
            nodes.push(this);
        }
        set parent(value) { this._parent = value; if (value) value.children.push(this); }
        get parent() { return this._parent; }
        get activeInHierarchy() { return this.isValid && this.active && (!this.parent || this.parent.activeInHierarchy); }
        addComponent(Type) { const c = new Type(); c.node = this; this.components.set(Type, c); return c; }
        getComponent(Type) { return this.components.get(Type); }
        setPosition(x, y) { this.position = { x, y }; }
        setWorldPosition(point) { this.worldPosition = { ...point }; }
        destroy() { this.isValid = false; this.handlers = []; this.children.forEach(n => n.destroy()); }
        on(type, fn, owner) { this.handlers.push({ type, fn, owner }); }
        emit(type,event) { for (const h of this.handlers) if (h.type === type) h.fn.call(h.owner,event); }
    }
    Node.EventType = { TOUCH_START: 'touch-start', TOUCH_MOVE: 'touch-move', TOUCH_END: 'touch-end', TOUCH_CANCEL: 'touch-cancel' };
    class Vec2 {
        constructor(x=0,y=0) { Object.assign(this,{x,y}); }
        set(x,y) { Object.assign(this,{x,y}); }
    }
    class Color { constructor(r,g,b,a=255) { Object.assign(this,{r,g,b,a}); } }
    const visible = { width: 800, height: 1400 };
    const cc = { Node, UITransform, Graphics, Label, Mask, Button, BlockInputEvents, ScrollView, Camera: class {}, Color, Vec2, Vec3: Vec2,
        screen: { windowSize: { width: 800, height: 1400 } }, view: { getVisibleSize: () => visible },
        Director: { EVENT_AFTER_UPDATE: 'after' },
        director: { on: (event, fn, owner) => listeners.add(owner), off: (event, fn, owner) => listeners.delete(owner) } };
    cc.Color.WHITE = new Color(255,255,255);
    const core = setup();
    const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib/cocos/ScreenLogPanel.ts'), 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext('(function(require,module,exports){' + output + '\n})')(
        name => {
            if (name === 'cc') return cc;
            if (name.endsWith('/ScreenLogDefine')) return { ScreenLogDefine: core.D };
            if (name.endsWith('/ScreenLogViewport')) return { ScreenLogViewport: core.ScreenLogViewport };
            throw Error(name);
        }, module, module.exports);
    let closed = 0;
    const panel = new module.exports.ScreenLogPanel(log, () => { closed++; log.stop(); }, onCopy);
    const host = new Node('host'), camera = { isValid: true, screenToWorld: value => value };
    const text = () => nodes.filter(n => n.activeInHierarchy && n.getComponent(Label)).map(n => n.getComponent(Label).string).join('\n');
    return { panel, host, camera, nodes, listeners, Label, UITransform, BlockInputEvents, text, cc, visible,
        tick: () => [...listeners].forEach(p => p._render()), closed: () => closed };
}

test('面板默认穿透，仅模式按钮开启滚动命中；暂停筛选和关闭继续生效', () => {
    const s = setup(); s.log.start(); const p = panelSetup(s.log); p.panel.show(p.host, p.camera);
    const viewport = p.nodes.find(n => n.name === 'Viewport');
    const transform = viewport.getComponent(p.UITransform), block = viewport.getComponent(p.BlockInputEvents);
    assert.equal(transform.hitTest(), false); assert.equal(block.enabled, false);
    assert.equal(p.panel._header.string, '屏幕日志');
    assert.equal(p.nodes.some(n => n.name === 'Status'), false);
    s.console.error('错误证据'); p.tick(); assert.ok(p.text().includes('错误证据'));
    p.nodes.find(n => n.name === 'Mode').emit('click');
    assert.equal(transform.hitTest(), true); assert.equal(block.enabled, true);
    assert.equal(p.panel._modeLabel.string, '穿透游戏');
    p.nodes.find(n => n.name === 'Mode').emit('click');
    assert.equal(transform.hitTest(), false); assert.equal(block.enabled, false);
    s.log.paused = true; p.tick();
    const count = s.log.recent().length;
    s.console.log('暂停期间不采集'); assert.equal(s.log.recent().length, count);
    s.log.source = 'touch'; p.tick(); assert.ok(p.text().includes('暂无匹配日志'));
    p.panel.hide(); assert.equal(p.listeners.size, 0); assert.equal(s.log.enabled, false);
    assert.equal(p.panel.visible, false); assert.equal(p.closed(), 1);
});

test('持续追加并上下滚动仅复用可见行节点，关闭后全部释放', () => {
    const s = setup(); s.log.start(); const p = panelSetup(s.log); p.panel.show(p.host, p.camera);
    for (let i=0;i<500;i++) { s.log.append('console','log',`消息 ${i}`); p.tick(); }
    assert.equal(s.log.recent(1000).length, 200);
    p.nodes.find(n=>n.name==='Mode').emit('click');
    const scroll = p.panel._scroll;
    for (let offset=0;offset<p.panel._model.maxOffset;offset+=23) scroll.scrollToOffset({y:offset});
    assert.ok(p.panel._rowPool.length <= Math.ceil(p.panel._viewHeight/25)+3);
    assert.equal(p.nodes.filter(n=>n.name==='LogRow').length, p.panel._rowPool.length);
    assert.ok(p.text().includes('消息 499'));
    p.panel.hide(); assert.equal(p.panel._rowPool.length,0);
    assert.ok(p.nodes.filter(n=>n.name==='LogRow').every(n=>!n.isValid));
});

test('宿主销毁后自动清理监听、节点池和控制台观察，可再次打开', () => {
    const s = setup(); s.log.start(); const p = panelSetup(s.log); p.panel.show(p.host, p.camera);
    p.host.destroy(); p.tick();
    assert.equal(p.listeners.size, 0); assert.equal(s.log.enabled, false);
    assert.equal(s.console.warn, s.original.warn);
    s.log.start(); const host = new p.host.constructor('newHost'); p.panel.show(host, p.camera);
    s.console.warn('重新开启'); p.tick();
    assert.ok(p.text().includes('重新开启'));
});

test('上翻期间追加和缓冲淘汰保持同一阅读行，回到底部恢复跟随', () => {
    const s=setup();s.log.start();const v=new s.ScreenLogViewport();
    for(let i=0;i<200;i++)s.log.append('console','log',`消息 ${i}`);
    v.update(s.log,100,100);assert.equal(v.offset,v.maxOffset);
    v.scroll(50*25+7);const key=v.rows[50].key;
    s.log.append('console','log','追加');v.update(s.log,100,100);
    assert.equal(v.rows[Math.floor(v.offset/25)].key,key);
    assert.equal(v.offset%25,7);assert.equal(v.following,false);
    v.scroll(v.maxOffset);s.log.append('console','log','尾部');v.update(s.log,100,100);
    assert.equal(v.offset,v.maxOffset);assert.equal(v.following,true);
});

test('当前历史已淘汰时停在最早可用行，筛选和清空重置跟随', () => {
    const s=setup();s.log.start();const v=new s.ScreenLogViewport();
    for(let i=0;i<200;i++)s.log.append('console',i%2?'warn':'log',`消息 ${i}`);
    v.update(s.log,100,100);v.scroll(0);
    s.log.append('console','log','追加');v.update(s.log,100,100);assert.equal(v.offset,0);
    s.log.severity='warning';v.update(s.log,100,100);assert.equal(v.offset,v.maxOffset);
    v.scroll(0);s.log.clear();s.log.append('console','warn','清空后');v.update(s.log,100,100);
    assert.equal(v.following,true);assert.equal(v.rows.length,2);
    assert.equal(v.rows[0].kind,'header');assert.ok(v.rows[1].text.includes('清空后'));
});

test('长消息与异常详情完整拆行，宽度变化和 MOVE 替换后缓存仍有界', () => {
    const s=setup();s.log.start();const v=new s.ScreenLogViewport();
    s.log.pinDetail('touch','详情首行\n第二行');
    const message='中文'.repeat(300)+'尾部标记';s.log.append('console','error',message);
    v.update(s.log,24,100);
    assert.ok(v.rows.map(r=>r.text).join('').includes(message));
    assert.ok(v.rows.map(r=>r.text).join('').includes('详情首行第二行'));
    v.scroll(50);v.update(s.log,12,150);
    assert.ok(v.range().end-v.range().start<=9);
    for(let i=0;i<300;i++){s.log.append('touch','log',`MOVE ${i}`,'move');v.update(s.log,12,150);}
    assert.equal(s.log.recent(200).length,2);assert.equal(v._cache.size,3);
});


test('标题拖动不改变正文穿透或滚动位置，取消后停止移动且位置不会被新日志重置', () => {
    const s=setup();s.log.start();const p=panelSetup(s.log);p.panel.show(p.host,p.camera);
    const handle=p.nodes.find(n=>n.name==='DragHandle'), node=p.panel._node;
    const touch={}, other={};
    const event=(x,y,owner=touch)=>({touch:owner,getLocation:()=>({x,y}),propagationStopped:false});
    const before={...node.worldPosition};
    const start=event(100,1250);handle.emit('touch-start',start);assert.equal(start.propagationStopped,true);
    const move=event(100,950);handle.emit('touch-move',move);assert.equal(move.propagationStopped,true);
    assert.ok(Math.abs(node.worldPosition.y-(before.y-300))<1e-6);
    const moved={...node.worldPosition};
    handle.emit('touch-move',event(100,100,other));assert.deepEqual(node.worldPosition,moved);
    handle.emit('touch-cancel',event(100,950));handle.emit('touch-move',event(100,700));
    assert.deepEqual(node.worldPosition,moved);
    assert.equal(p.panel._viewport.getComponent(p.UITransform).hitTest(),false);
    assert.equal(p.panel._scroll.getScrollOffset().y,0);
    s.log.append('console','log','拖动后新消息');p.tick();assert.deepEqual(node.worldPosition,moved);
    p.panel.hide();s.log.start();p.panel.show(p.host,p.camera);assert.deepEqual(p.panel._node.worldPosition,moved);
});

test('拖动到屏幕边缘会约束位置，窗口缩放和转屏后仍在可见范围内', () => {
    const s=setup();s.log.start();const p=panelSetup(s.log);p.panel.show(p.host,p.camera);
    const handle=p.nodes.find(n=>n.name==='DragHandle'), touch={};
    const event=(x,y)=>({touch,getLocation:()=>({x,y})});
    handle.emit('touch-start',event(100,1200));handle.emit('touch-move',event(-9999,-9999));
    assert.ok(p.panel._node.worldPosition.x>=0);
    assert.ok(p.panel._node.worldPosition.y>=p.panel._height);
    handle.emit('touch-move',event(9999,9999));handle.emit('touch-end',event(9999,9999));
    assert.ok(p.panel._node.worldPosition.x+p.panel._width<=800);
    assert.ok(p.panel._node.worldPosition.y<=1400);
    const ratio={...p.panel._position};
    p.cc.screen.windowSize={width:1600,height:2800};p.tick();
    assert.equal(p.panel._node.worldPosition.x,1600*ratio.x);
    assert.equal(p.panel._node.worldPosition.y,2800*ratio.y);
    p.visible.width=1400;p.visible.height=800;p.cc.screen.windowSize={width:1400,height:800};p.tick();
    assert.ok(p.panel._node.worldPosition.x+p.panel._width<=1400);
    assert.ok(p.panel._node.worldPosition.y>=p.panel._height);
    assert.ok(p.panel._node.worldPosition.y<=800);
});

test('五种等级颜色不同，长消息续行保留等级，复用节点不残留旧颜色', () => {
    const s=setup();s.log.start();const p=panelSetup(s.log);p.panel.show(p.host,p.camera);
    for(const level of s.D.LEVELS)s.log.append('console',level,`等级 ${level}`);
    p.tick();
    for(const level of s.D.LEVELS){
        const label=p.panel._rowPool.find(l=>l.string===`等级 ${level}`);
        assert.deepEqual([label.color.r,label.color.g,label.color.b],Array.from(s.D.LEVEL_COLORS[level]));
        const header=p.panel._rowPool.find(l=>l.string.endsWith(`控制台 · ${level.toUpperCase()}`));
        assert.ok(header);assert.equal(header.fontSize,s.D.ENTRY_HEADER_FONT_SIZE);assert.equal(header.isBold,true);
        assert.equal(label.fontSize,s.D.FONT_SIZE);assert.equal(label.isBold,false);
        assert.ok(label.node.position.x>header.node.position.x);
    }
    const reused=p.panel._rowPool[0];
    s.log.clear();s.log.append('console','error','错误长消息'.repeat(100));p.tick();
    assert.ok(p.panel._model.rows.every(r=>r.level==='error'));
    assert.equal(p.panel._rowPool[0],reused);
    assert.equal(reused.color.r,255);assert.equal(reused.color.g,120);
    s.log.clear();s.log.append('console','log','恢复普通');p.tick();
    assert.equal(p.panel._rowPool[0],reused);
    assert.deepEqual([reused.color.r,reused.color.g,reused.color.b],[151,198,239]);
    assert.equal(reused.isBold,true);
    const body=p.panel._rowPool.find(l=>l.string==='恢复普通');
    assert.deepEqual([body.color.r,body.color.g,body.color.b],[255,255,255]);
});


function tapRestore(p) {
    const node=p.nodes.find(n=>n.name==='Restore'&&n.isValid),touch={};
    const event=type=>({touch,getLocation:()=>({x:30,y:1000}),getEventCode:()=>type});
    node.emit('touch-start',event('touch-start'));
    node.emit('touch-end',event('touch-end'));
}

test('最小化只保留日志入口，采集继续且不更新行节点；点击恢复最新日志', () => {
    const s=setup();s.log.start();const p=panelSetup(s.log);p.panel.show(p.host,p.camera);
    for(let i=0;i<80;i++)s.log.append('console','log',`消息 ${i}`);p.tick();
    const nodes=p.nodes.length,pool=p.panel._rowPool.slice(),before=p.panel._rowPool.map(l=>l.string);
    p.nodes.find(n=>n.name==='Minimize').emit('click');
    assert.equal(p.panel.visible,true);assert.equal(s.log.enabled,true);assert.equal(p.closed(),0);
    assert.equal(p.panel._viewport.active,false);
    assert.equal(p.panel._viewport.getComponent(p.UITransform).hitTest(),false);
    assert.equal(p.panel._node.getComponent(p.UITransform).width,s.D.MINIMIZED_WIDTH);
    assert.equal(p.text(),'日志 +');
    for(let i=0;i<100;i++){s.log.append('console','error',`隐藏期间 ${i}`);p.tick();}
    assert.equal(p.nodes.length,nodes);assert.deepEqual(p.panel._rowPool.map(l=>l.string),before);
    tapRestore(p);
    assert.equal(p.panel._minimized,false);assert.equal(p.panel._interactive,false);
    assert.ok(p.text().includes('隐藏期间 99'));
    assert.ok(pool.every((label,i)=>p.panel._rowPool[i]===label));
    for(let i=0;i<20;i++){p.nodes.find(n=>n.name==='Minimize').emit('click');tapRestore(p);}
    assert.equal(p.nodes.length,nodes);
});

test('查看历史时收起和展开保留模式及阅读锚点，暂停采集状态不变', () => {
    const s=setup();s.log.start();const p=panelSetup(s.log);p.panel.show(p.host,p.camera);
    for(let i=0;i<200;i++)s.log.append('console','log',`消息 ${i}`);p.tick();
    p.nodes.find(n=>n.name==='Mode').emit('click');p.panel._scroll.scrollToOffset({y:50*25+7});
    const key=p.panel._model.rows[50].key;
    p.nodes.find(n=>n.name==='Minimize').emit('click');
    s.log.append('console','log','追加并淘汰首条');p.tick();s.log.paused=true;
    tapRestore(p);
    assert.equal(p.panel._interactive,true);assert.equal(p.panel._block.enabled,true);
    assert.equal(p.panel._viewport.getComponent(p.UITransform).hitTest(),true);
    assert.equal(s.log.paused,true);assert.equal(p.panel._model.following,false);
    assert.equal(p.panel._model.rows[Math.floor(p.panel._model.offset/25)].key,key);
    assert.equal(p.panel._model.offset%25,7);
});

test('最小化入口拖动或取消不误展开，展开后面板约束回屏幕内', () => {
    const s=setup();s.log.start();const p=panelSetup(s.log);p.panel.show(p.host,p.camera);
    p.nodes.find(n=>n.name==='Minimize').emit('click');
    const restore=p.nodes.find(n=>n.name==='Restore'),touch={};
    const event=(type,x,y)=>({touch,getEventCode:()=>type,getLocation:()=>({x,y})});
    restore.emit('touch-start',event('touch-start',30,1000));
    restore.emit('touch-move',event('touch-move',9000,-9000));
    restore.emit('touch-end',event('touch-end',9000,-9000));
    assert.equal(p.panel._minimized,true);
    assert.ok(p.panel._node.worldPosition.x+s.D.MINIMIZED_WIDTH<=800);
    assert.ok(p.panel._node.worldPosition.y>=s.D.MINIMIZED_HEIGHT);
    restore.emit('touch-start',event('touch-start',30,1000));
    restore.emit('touch-cancel',event('touch-cancel',30,1000));assert.equal(p.panel._minimized,true);
    tapRestore(p);assert.equal(p.panel._minimized,false);
    assert.ok(p.panel._node.worldPosition.x+p.panel._width<=800);
    assert.ok(p.panel._node.worldPosition.y>=p.panel._height);
    p.nodes.find(n=>n.name==='Minimize').emit('click');p.panel.hide();
    assert.equal(p.listeners.size,0);assert.equal(s.log.enabled,false);
    assert.ok(p.nodes.filter(n=>n!==p.host).every(n=>!n.isValid));
    s.log.start();p.panel.show(p.host,p.camera);assert.equal(p.panel._minimized,false);
});

test('入口拖到右下角后反复展开收起仍留在原处，面板拖动与关闭重开不覆盖入口位置', () => {
    const s=setup();s.log.start();const p=panelSetup(s.log);p.panel.show(p.host,p.camera);
    const expanded={...p.panel._node.worldPosition};
    const minimize=()=>p.nodes.find(n=>n.name==='Minimize'&&n.isValid).emit('click');
    minimize();assert.deepEqual(p.panel._node.worldPosition,expanded);
    const restore=p.nodes.find(n=>n.name==='Restore'),touch={};
    const event=(type,x,y)=>({touch,getEventCode:()=>type,getLocation:()=>({x,y})});
    restore.emit('touch-start',event('touch-start',expanded.x+10,expanded.y-10));
    restore.emit('touch-move',event('touch-move',9000,-9000));
    restore.emit('touch-end',event('touch-end',9000,-9000));
    const compact={...p.panel._node.worldPosition};
    assert.ok(compact.x>600&&compact.y<100);
    for(let i=0;i<3;i++){
        tapRestore(p);assert.deepEqual(p.panel._node.worldPosition,expanded);
        minimize();assert.deepEqual(p.panel._node.worldPosition,compact);
    }
    tapRestore(p);
    const handle=p.nodes.find(n=>n.name==='DragHandle');
    handle.emit('touch-start',event('touch-start',expanded.x+10,expanded.y-10));
    handle.emit('touch-move',event('touch-move',expanded.x+10,expanded.y-310));
    handle.emit('touch-end',event('touch-end',expanded.x+10,expanded.y-310));
    const movedPanel={...p.panel._node.worldPosition};
    assert.ok(Math.abs(movedPanel.y-(expanded.y-300))<1e-6);
    minimize();assert.deepEqual(p.panel._node.worldPosition,compact);
    tapRestore(p);assert.deepEqual(p.panel._node.worldPosition,movedPanel);
    p.panel.hide();s.log.start();p.panel.show(p.host,p.camera);
    assert.deepEqual(p.panel._node.worldPosition,movedPanel);
    minimize();assert.deepEqual(p.panel._node.worldPosition,compact);
});

test('右下角可独立调整宽高，正文仍穿透，追加日志、收起及重开保留尺寸', () => {
    const s=setup();s.log.start();const p=panelSetup(s.log);p.panel.show(p.host,p.camera);
    const handle=p.panel._resizeHandle,touch={},other={};
    const event=(x,y,owner=touch)=>({touch:owner,getLocation:()=>({x,y}),propagationStopped:false});
    const position={...p.panel._node.worldPosition};
    const start=event(790,794);handle.emit('touch-start',start);assert.equal(start.propagationStopped,true);
    const move=event(514,1004);handle.emit('touch-move',move);p.tick();
    assert.equal(move.propagationStopped,true);assert.equal(p.panel._width,500);assert.equal(p.panel._height,300);
    assert.deepEqual(p.panel._node.worldPosition,position);
    handle.emit('touch-move',event(100,100,other));p.tick();assert.equal(p.panel._width,500);
    handle.emit('touch-end',event(514,1004));
    assert.equal(p.panel._viewport.getComponent(p.UITransform).hitTest(),false);assert.equal(p.panel._block.enabled,false);
    s.log.append('console','log','尺寸不随日志变化');p.tick();assert.equal(p.panel._height,300);
    p.nodes.find(n=>n.name==='Minimize').emit('click');assert.equal(handle.active,false);
    tapRestore(p);assert.equal(handle.active,true);assert.equal(p.panel._width,500);assert.equal(p.panel._height,300);
    p.panel.hide();s.log.start();p.panel.show(p.host,p.camera);
    assert.equal(p.panel._width,500);assert.equal(p.panel._height,300);
});

test('缩放限制最小尺寸与屏幕边界，取消和转屏终止旧缩放手势', () => {
    const s=setup();s.log.start();const p=panelSetup(s.log);p.panel.show(p.host,p.camera);
    const handle=p.panel._resizeHandle,touch={};
    const event=(x,y)=>({touch,getLocation:()=>({x,y})});
    handle.emit('touch-start',event(790,794));handle.emit('touch-move',event(-9999,9999));p.tick();
    assert.equal(p.panel._width,s.D.MIN_PANEL_WIDTH);assert.equal(p.panel._height,s.D.MIN_PANEL_HEIGHT);
    handle.emit('touch-move',event(9999,-9999));p.tick();
    assert.ok(p.panel._node.worldPosition.x+p.panel._width<=796);
    assert.ok(p.panel._node.worldPosition.y-p.panel._height>=4);
    handle.emit('touch-cancel',event(9999,-9999));const width=p.panel._width;
    handle.emit('touch-move',event(100,100));p.tick();assert.equal(p.panel._width,width);
    handle.emit('touch-start',event(790,794));
    p.visible.width=500;p.visible.height=350;p.cc.screen.windowSize={width:500,height:350};p.tick();
    assert.equal(p.panel._resizeTouch,null);
    assert.ok(p.panel._width<=492);assert.ok(p.panel._height<=342);
    const resized=p.panel._width;handle.emit('touch-move',event(-999,999));p.tick();assert.equal(p.panel._width,resized);
});

test('缩放按物理像素换算，查看模式重排后保留当前日志而非跳到最早记录', () => {
    const s=setup();s.log.start();const p=panelSetup(s.log);p.panel.show(p.host,p.camera);
    for(let i=0;i<80;i++)s.log.append('console','log',`历史 ${i} `+'文字'.repeat(80));p.tick();
    p.nodes.find(n=>n.name==='Mode').emit('click');
    p.cc.screen.windowSize={width:1600,height:2800};p.tick();
    const handle=p.panel._resizeHandle,touch={};
    const event=(x,y)=>({touch,getLocation:()=>({x,y})});
    handle.emit('touch-start',event(1500,1600));handle.emit('touch-move',event(900,1800));p.tick();
    handle.emit('touch-end',event(900,1800));
    assert.equal(p.panel._width,476);assert.equal(p.panel._height,410);
    const rows=p.panel._model.rows;
    const anchor=rows.filter(r=>r.key.startsWith('entry:30:')).at(-1);
    p.panel._scroll.scrollToOffset({y:rows.indexOf(anchor)*25+7});
    handle.emit('touch-start',event(900,1800));handle.emit('touch-move',event(1500,1800));p.tick();
    handle.emit('touch-end',event(1500,1800));
    assert.equal(p.panel._width,776);assert.equal(p.panel._model.following,false);
    assert.ok(p.panel._model.rows[Math.floor(p.panel._model.offset/25)].key.startsWith('entry:30:'));
    assert.equal(p.panel._interactive,true);assert.equal(p.panel._block.enabled,true);
    assert.ok(p.panel._rowPool.filter(l=>l.node.active).length<=Math.ceil(p.panel._viewHeight/25)+3);
});

test('查看模式逐条复制原始内容，穿透模式不显示复制按钮', () => {
    const s = setup(); s.log.start(); const copied = [];
    const p = panelSetup(s.log, text => copied.push(text)); p.panel.show(p.host, p.camera);
    const message = '长日志\n' + '完整内容'.repeat(80);
    s.log.append('console', 'error', message); p.tick();
    assert.ok(p.panel._copyButtons.every(node => !node.active));
    p.nodes.find(node => node.name === 'Mode').emit('click');
    p.panel._scroll.scrollToOffset({ y: 0 });
    const button = p.panel._copyButtons.find(node => node.active);
    assert.ok(button);
    button.emit('touch-start'); button.emit('click');
    const entry = s.log.recent()[0];
    assert.equal(copied[0], `#${entry.sequence}  ${entry.time}  控制台 · ERROR\n${message}`);
    assert.equal(copied.length, 1);
    p.nodes.find(node => node.name === 'Mode').emit('click');
    assert.ok(p.panel._copyButtons.every(node => !node.active));
    button.emit('click'); assert.equal(copied.length, 1);
});

test('取消、滚动复用和清空后不复制旧按压，节点池与正文一起释放', () => {
    const s = setup(); s.log.start(); const copied = [];
    const p = panelSetup(s.log, text => copied.push(text)); p.panel.show(p.host, p.camera);
    for (let i = 0; i < 100; i++) s.log.append('console', 'log', `记录 ${i}`);
    p.tick(); p.nodes.find(node => node.name === 'Mode').emit('click');
    p.panel._scroll.scrollToOffset({ y: 0 });
    const button = p.panel._copyButtons[0];
    button.emit('touch-start'); button.emit('touch-cancel'); button.emit('click');
    assert.equal(copied.length, 0);
    button.emit('touch-start');
    p.panel._scroll.scrollToOffset({ y: 500 }); button.emit('click');
    assert.equal(copied.length, 0);
    const count = p.nodes.length;
    for (let y = 0; y < 2000; y += 50) p.panel._scroll.scrollToOffset({ y });
    assert.equal(p.nodes.length, count);
    p.panel._scroll.scrollToOffset({ y: 0 }); button.emit('touch-start');
    s.log.clear(); s.log.append('console', 'warn', '新记录'); p.tick(); button.emit('click');
    assert.equal(copied.length, 0);
    const current = p.panel._copyButtons.find(node => node.active);
    current.emit('touch-start'); current.emit('click');
    assert.ok(copied[0].endsWith('\n新记录'));
    p.panel.hide(); assert.equal(p.panel._copyButtons.length, 0);
    assert.ok(p.nodes.filter(node => node.name === 'CopyLog').every(node => !node.isValid));
});

test('首个异常详情可完整复制，未提供剪贴板回调时不显示按钮', () => {
    const s = setup(); s.log.start(); s.log.pinDetail('touch', '异常\n原始数据');
    const copied = []; const p = panelSetup(s.log, text => copied.push(text));
    p.panel.show(p.host, p.camera); p.nodes.find(node => node.name === 'Mode').emit('click');
    const button = p.panel._copyButtons.find(node => node.active);
    button.emit('touch-start'); button.emit('click');
    assert.equal(copied[0], '固定 · 首个异常详情\n[touch] 异常\n原始数据');
    const withoutCopy = panelSetup(s.log); withoutCopy.panel.show(withoutCopy.host, withoutCopy.camera);
    withoutCopy.nodes.find(node => node.name === 'Mode').emit('click');
    assert.ok(withoutCopy.panel._copyButtons.every(node => !node.active));
});

test('大数组格式化不枚举全部索引，最多读取前 20 项', () => {
    const s = setup(); let reads = 0;
    const value = new Proxy(Array.from({ length: 100000 }, (_, i) => i), {
        ownKeys() { throw Error('不允许全量枚举数组'); },
        getOwnPropertyDescriptor(target, key) {
            if (key !== 'length') reads++;
            return Reflect.getOwnPropertyDescriptor(target, key);
        },
    });
    const formatted = s.ScreenLog.format([value]);
    assert.equal(reads, 20);
    assert.ok(formatted.includes('19: 19')); assert.ok(formatted.includes('…'));
    assert.ok(!formatted.includes('20: 20'));
});

test('同一可见行范围内滚动不重绘正文，跨行才重绘', () => {
    const s = setup(); s.log.start();
    const p = panelSetup(s.log); p.panel.show(p.host, p.camera);
    for (let i = 0; i < 80; i++) s.log.append('console', 'log', `消息 ${i}`);
    p.tick(); p.nodes.find(node => node.name === 'Mode').emit('click');
    p.panel._scroll.scrollToOffset({ y: 110 });
    const background = p.panel._rowBackground, clears = background.clears;
    const barClears = p.panel._bar.clears;
    for (let y = 111; y <= 114; y++) p.panel._scroll.scrollToOffset({ y });
    assert.equal(background.clears, clears); assert.ok(p.panel._bar.clears > barClears);
    p.panel._scroll.scrollToOffset({ y: 151 }); assert.ok(background.clears > clears);
});

test('复制按钮仅在查看模式按可见标题分配，不为正文行创建', () => {
    const s = setup(); s.log.start();
    const p = panelSetup(s.log, () => {}); p.panel.show(p.host, p.camera);
    s.log.append('console', 'log', '长日志'.repeat(300)); p.tick();
    assert.equal(p.panel._copyButtons.length, 0);
    p.nodes.find(node => node.name === 'Mode').emit('click');
    p.panel._scroll.scrollToOffset({ y: 0 });
    assert.equal(p.panel._copyButtons.length, 1);
    assert.ok(p.panel._rowPool.length > 10);
    p.panel._scroll.scrollToOffset({ y: 500 });
    assert.equal(p.panel._copyButtons.length, 1);
    assert.ok(p.panel._copyButtons.every(node => !node.active));
});

test('连续追加复用历史行列表，不再次读取全量日志', () => {
    const s = setup(); s.log.start(); const v = new s.ScreenLogViewport();
    s.log.append('console', 'log', '首条'); v.update(s.log, 40, 100);
    const rows = v.rows, first = rows[0]; let reads = 0;
    const recent = s.log.recent.bind(s.log);
    s.log.recent = (...args) => { reads++; return recent(...args); };
    for (let i = 0; i < 30; i++) { s.log.append('console', 'log', `追加 ${i}`); v.update(s.log, 40, 100); }
    assert.equal(reads, 0); assert.equal(v.rows, rows); assert.equal(v.rows[0], first);
    assert.equal(v.rows.length, 62);
});

test('增量结果与全量重建一致，覆盖替换、淘汰、筛选、重排与落后回退', () => {
    const s = setup(); s.log.start(); const v = new s.ScreenLogViewport();
    let columns = 30;
    const verify = () => {
        v.update(s.log, columns, 100);
        const full = new s.ScreenLogViewport(); full.update(s.log, columns, 100);
        assert.equal(JSON.stringify(v.rows), JSON.stringify(full.rows));
        assert.equal(v.contentHeight, full.contentHeight);
        assert.ok(v._cache.size <= 201);
    };
    verify();
    for (let i = 0; i < 500; i++) {
        s.log.append(i % 3 ? 'console' : 'touch', i % 5 ? 'log' : 'error', `记录 ${i}\n` + '长内容'.repeat(i % 20), i % 3 ? '' : 'move');
        if (i % 7 === 0) verify();
        if (i === 70) s.log.pinDetail('touch', '首个异常');
        if (i === 130) s.log.source = 'touch';
        if (i === 170) s.log.source = '';
        if (i === 210) s.log.severity = 'error';
        if (i === 250) s.log.severity = 'all';
        if (i === 290) columns = 15;
        if (i === 350) s.log.clear();
    }
    verify();
    for (let i = 0; i < 250; i++) s.log.append('console', 'log', `未刷新 ${i}`);
    verify(); assert.equal(s.log._changes.length, 200);
});
