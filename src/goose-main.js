'use strict';
/* =============================================================================
   线条小狗桌宠 —— Desktop Goose 风格捣蛋行为（主进程侧）
   -----------------------------------------------------------------------------
   由 main.js 在 app ready 后调用 setupGoose(deps) 启动。本模块负责：
     · 叼鼠标  —— 把系统光标拽到狗嘴边，拖着它走 8~15 秒
     · 表情包弹窗 —— 从屏幕边缘拖入表情包 GIF / 小狗留言（可点关闭，关了它会生气）
     · 捣蛋调度 —— 弹窗/叼鼠标/小剧本随机触发
     · 脚印落印 —— 狗走/跑时在全屏透明层上落爪印
     · 戳它反击 —— 被连点 3 次后报复（拽光标）
     · 长按 ESC 退出
  与渲染端的接口：主 → 渲染 'goose:cmd'（steal/release/angry/bark/chase），
  渲染 → 主 'goose:action'（poke 等）。
  ============================================================================= */

const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const ASSET_DIR = path.join(__dirname, '..', 'assets');
const MEME_DIR = path.join(ASSET_DIR, 'memes');
// 开发模式：tools/ 在项目根；打包后 move-mouse 通过 extraResources 进
// Contents/Resources/tools/（app.asar 内无法跑外部二进制）。
// 二进制按平台分开：macOS 是 Swift 编译的 move-mouse（需辅助功能授权），
// Windows 是 C 编译的 move-mouse.exe（SetCursorPos，无需授权，见 tools/move-mouse.c）。
const MOVE_MOUSE_NAME = process.platform === 'win32' ? 'move-mouse.exe' : 'move-mouse';
const MOVE_MOUSE = app.isPackaged
  ? path.join(process.resourcesPath, 'tools', MOVE_MOUSE_NAME)
  : path.join(__dirname, '..', 'tools', MOVE_MOUSE_NAME);

// ---------------------------------------------------------------------------
// 设置（独立于官方 desktop-pet.json，存 userData/goose.json）
// ---------------------------------------------------------------------------
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'goose.json');
const DEFAULTS = {
  enabled: true,      // 捣蛋总开关
  stealMouse: true,   // 叼鼠标
  memes: true,        // 表情包弹窗
  bark: true,         // 汪汪
  footprints: true,   // 脚印
  skit: true,         // 微型剧本（追尾巴/犯困/挖宝等小剧场）
  aggression: 2,      // 捣蛋频率 1=佛系 2=正常 3=疯狂
};
let settings = null;
// 安静模式（V2 idle-system 深度空闲时开启）：降频 + 停弹窗/叼鼠标/汪汪/剧本
let quietLevel = 'normal';   // 三模式（§36）：normal / quiet / dnd
let quietMode = false;
function setQuietLevel(level) {
  quietLevel = (level === 'quiet' || level === 'dnd') ? level : 'normal';
  quietMode = quietLevel === 'dnd';   // dnd（勿扰）：所有主动捣蛋 = 0
}
// 兼容旧调用（如仅布尔传参）：true = dnd
function setQuiet(v) { setQuietLevel(v ? 'dnd' : 'normal'); }


function loadSettings() {
  try { settings = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'))); }
  catch (e) { settings = Object.assign({}, DEFAULTS); }
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); } catch (e) {}
}

// ---------------------------------------------------------------------------
// 依赖注入（由 main.js 提供）
// ---------------------------------------------------------------------------
let deps = null;
function dogPos()   { return deps && deps.getDogPos ? deps.getDogPos() : { x: 400, y: 300 }; }
function petState() { return deps && deps.getPetState ? deps.getPetState() : { state: 'idle' }; }
function sendToPet(m) { if (deps && deps.sendToPet) deps.sendToPet(m); }

// ---------------------------------------------------------------------------
// 光标控制（tools/move-mouse[.exe]：macOS 走 CGEvent，Windows 走 SetCursorPos）
// ---------------------------------------------------------------------------
let moveQueue = 0;
function moveCursor(x, y, cb) {
  if (!x || !y) return;
  // Windows：狗的位置 / 光标位置都是 Electron 的 DIP（逻辑像素），而
  // SetCursorPos 要**物理像素**。缩放 ≠100% 时不换算光标会落偏（150% 时
  // 只走到目标的 2/3 处）；dipToScreenPoint 是 Windows 专有 API，按显示器
  // 逐个换算，多屏不同缩放也准。macOS 的 CGEvent 本来就用点坐标，不用换。
  const p = process.platform === 'win32'
    ? screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) })
    : { x: Math.round(x), y: Math.round(y) };
  moveQueue += 1;
  execFile(MOVE_MOUSE, [String(p.x), String(p.y)], { windowsHide: true }, (err) => {
    moveQueue -= 1;
    if (err && process.env.GOOSE_DEBUG) console.error('[goose] move-mouse:', err.message);
    if (cb) cb();
  });
}
function cursorPos() { return screen.getCursorScreenPoint(); }

// ---------------------------------------------------------------------------
// 汪汪：提示音已删除，bark 静默（保留调用通道，动作动画不受影响）
// ---------------------------------------------------------------------------
function bark(times) {
  if (quietMode || !settings.bark) return;
  if (process.env.GOOSE_DEBUG) console.log('[goose] bark x' + (times || 1));
  sendToPet({ type: 'bark', times: times || 1 });
}

// ---------------------------------------------------------------------------
// 脚印：全屏透明爪印层
// ---------------------------------------------------------------------------
let fpWin = null;
function createFootprintWindow() {
  if (!settings.footprints) return;
  const wa = screen.getPrimaryDisplay().workArea;
  fpWin = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true, frame: false, resizable: false, movable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
    show: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload-fp.js'),
                      contextIsolation: true, nodeIntegration: false, sandbox: false,
                      backgroundThrottling: false },
  });
  fpWin.setIgnoreMouseEvents(true, { forward: true });   // 全程穿透，绝不挡操作
  fpWin.loadFile(path.join(RENDERER_DIR, 'footprint.html'));
  fpWin.once('ready-to-show', () => fpWin.show());
  fpWin.on('closed', () => { fpWin = null; });
}
function dropFootprint() {
  if (!settings.footprints || !fpWin || fpWin.isDestroyed()) return;
  const st = petState();
  if (st.state !== 'walk' && st.state !== 'run') return;   // 只有走/跑才落印
  const p = dogPos();
  fpWin.webContents.send('fp:add', { x: Math.round(p.x), y: Math.round(p.y + 40) });
}

// ---------------------------------------------------------------------------
// 叼鼠标
// ---------------------------------------------------------------------------
let stealing = null;          // { since, until, hold, anim }
const STEAL_HOLD_MS = [8000, 15000];

function stealCursor() {
  if (quietMode || !settings.enabled || !settings.stealMouse) return;
  if (stealing) return;
  const p = dogPos();
  const cur = cursorPos();
  if (Math.hypot(cur.x - p.x, cur.y - p.y) < 25) return;   // 几乎贴脸才不叼（放宽，让捣蛋更常见）
  const hold = STEAL_HOLD_MS[0] + Math.random() * (STEAL_HOLD_MS[1] - STEAL_HOLD_MS[0]);
  stealing = { until: Date.now() + hold, last: 0 };
  sendToPet({ type: 'steal' });
  if (process.env.GOOSE_DEBUG) console.log('[goose] steal cursor for', Math.round(hold / 1000) + 's');
}

let lastStealMoveAt = 0;
function tickSteal() {
  if (!stealing) return;
  // 拖鼠标 15Hz 就够了（每次 moveCursor 都要 spawn 一个子进程，
  // 原 60Hz = 每秒 60 次进程创建，纯浪费 CPU；15Hz 视觉完全无差）。
  const now = Date.now();
  if (now - lastStealMoveAt < 66) return;
  lastStealMoveAt = now;
  const p = dogPos();
  // 狗嘴位置 ≈ 狗身中心上方一点（叼着走时光标在嘴前）
  const mouthX = p.x + (petState().facing === -1 ? -30 : 30);
  const mouthY = p.y - 20 + (Math.random() * 8 - 4);        // 轻微抖动更像叼着
  moveCursor(mouthX, mouthY);
  // 拖拽期间狗会继续漫游（窗口由 main.js 的 60Hz tick 驱动）
  if (Date.now() > stealing.until) {
    stealing = null;
    sendToPet({ type: 'release' });
    if (process.env.GOOSE_DEBUG) console.log('[goose] cursor released');
  }
}

// ---------------------------------------------------------------------------
// 表情包 / 留言弹窗
// ---------------------------------------------------------------------------
const memes = [];           // 可用表情包文件列表
const MEME_NOTES = [        // 预置小狗留言（没有表情包文件时也用）
  '汪汪！你的电脑归我管了。',
  '今天也要开心哦！—— 线条小狗',
  '摸我一下，好运+1。',
  '别上班了，陪我玩。',
  '你摸了我 3 次，我要报复你了。',
  '桌面这么大，都是我的散步场地。',
  '鼠标借我用一下，马上还你（大概 15 秒）。',
];
const memeWins = [];        // 当前弹窗集合（最多 3 个）

// ---------------------------------------------------------------------------
// 表情包内容映射（GIF 名称/内容 → 小狗动作 + 呼应台词）
// 弹窗弹出某张表情包时，小狗先做对应动作、再说一句应景的话，
// 让 297 张表情包全部「有用上」，且图、话、动作三者对得上。
// ---------------------------------------------------------------------------
const MEME_MAP = [
  { keys: ['cry','tear','woo','sad','unhappy','depressed','sulk','sob','heartbroken','shatter','arrow','frustrated','sad-face'],
    act: 'cry', lines: ['别哭啦 我在呢','谁欺负你了 我帮你','抱抱你 不哭了'] },
  { keys: ['sleep','sleepy','tired','lie','tummy','stay-up','drop','wake','night','asleep','faint'],
    act: 'sleep', lines: ['困困的 眯一会儿…','晚安呀 明天见','呼…做个好梦'] },
  { keys: ['dance','disco','spin','sway','rock','hum-sing','la-la-la','piano','drum','clap'],
    act: 'dance', lines: ['跟着一起摇～','哼哼～啦啦啦','动次打次！'] },
  { keys: ['happy','ha-ha','yay','cheer','thrill','excited','smug','proud','superb','awesome','very-good','powerful','high-five','celebrate','firework','take-off','jump-jump','great','strong','good-yay'],
    act: 'celebrate', lines: ['太开心啦！','好运都来啦！','今天超顺利！'] },
  { keys: ['eat','rice','crave','hungry','beg','smack','lick','noodle','cake','coffee','drink','full','medicine','hey','chomp'],
    act: 'eat', lines: ['饿啦 给口饭饭嘛','闻到了香味 我也想吃！','好吃！'] },
  { keys: ['heart','love','like','flower','gift','snuggle','hug','piggyback','kiss','rose','small-heart','blow-heart','bring-heart','hurl-heart','toss-heart','catch-heart','receive-heart','heart-delivered','heart-coming','small-flower'],
    act: 'excited', lines: ['爱你+1！','贴贴最舒服','我超喜欢你！'] },
  { keys: ['angry','fierce','glare','bite','hit','kick','bump','tug','menace','devil','gnash','shadow-punch','slam-desk','arrest','warn','vicious','pfft','humph','strike','mhm'],
    act: 'wrong', lines: ['哼！别惹我！','我生起气来自己都怕','你哄我一下嘛'] },
  { keys: ['afraid','tremble','surprised','shocked','fright','frozen','messy','nervous','alert','sweat','shock','surprise','twist','perspire'],
    act: 'jump', lines: ['吓我一跳！','呜哇——好突然','什么情况！'] },
  { keys: ['work','paddle','lying','slouch','collapse','never-finish','cant-write','read-book','study','think','strive','hold-on','endure','fighting','can-do','go-work'],
    act: 'bored', lines: ['上班好累 想躺平','陪着你 一起加油','慢慢来 不急'] },
  { keys: ['hello','morning','wave','coming','im-coming','looking-me','appear','pop-up','open-door','phone','receive-msg','here','nod','bow','point','howdy','im-listening'],
    act: 'greet', lines: ['嗨～我在这里','我来啦我来啦','你好呀！'] },
  { keys: ['play','ball','jump-rope','exercise','weightlifting','game','itching-to','expect','ready','somersault','boxing','ball-struck'],
    act: 'exercise', lines: ['一起玩吧！','锻炼一下 身体棒棒！','冲鸭！'] },
  { keys: ['money','obtain-money','deliver-money','receive-money','send-money','money-none','lucky','happy-new-year','happy-birthday','new-year'],
    act: 'celebrate', lines: ['发财啦！好运都来！','收到钱钱 超开心！'] },
  { keys: ['pat','rub','nuzzle','tickle','poke','tap','wipe','wash','shower','mop','drag','pull','tug','shake','flick','swing','wag','cross','roll','wrap','lift','sit-up','hide','walk-together','draw-circle','note-down','head-shake','knead','yank','trail','ear-shake'],
    act: 'rub', lines: ['揉揉脸 舒服～','蹭蹭你～','摸摸头 好乖'] },
  { keys: ['poop'],
    act: 'fart', lines: ['不是我哦！'] },
  { keys: ['bark'],
    act: 'excited', lines: ['汪！汪汪！','汪～ 叫我吗'] },
  { keys: ['good','done','okay','will-be-ok','affirm','best-friend'],
    act: 'celebrate', lines: ['好呀好呀！','完美完成！','真不错！'] },
  { keys: ['refuse','reject','quit','surrender','cannot-look','donot'],
    act: 'wrong', lines: ['不要嘛…','我才不要呢','你哄哄我呀'] },
  { keys: ['what','question','suspicious','tilt-head','frown','ah','hmm','emm','confused','daze','emo'],
    act: 'bored', lines: ['嗯？怎么了','你在想什么呀','我有点好奇'] },
  { keys: ['tumble','step','ouch','unwell','feel-sorry','teeth','shrug'],
    act: 'wronged', lines: ['呜 好痛…','心疼你 抱抱','要亲亲才能好'] },
  { keys: ['annoyed','hurry','rush'],
    act: 'run', lines: ['来了来了！','急死我啦','等等我呀！'] },
  { keys: ['thanks','sorry','im-wrong'],
    act: 'wrong', lines: ['对不起啦…','我错了我错了','你会原谅我吗'] },
  { keys: ['shy','hehe'],
    act: 'hehe', lines: ['嘿嘿～','有点小得意','别看我啦'] },
  { keys: ['wish','cheers','congrat'],
    act: 'celebrate', lines: ['愿望都会实现的！','干杯！','祝贺你呀！'] },
  { keys: ['airplane','drive','sprint','bail','crawl','fly'],
    act: 'run', lines: ['冲鸭！','速度超快！','风都是甜的！'] },
  { keys: ['calm','relax','breeze','look-window','round','daze','confused'],
    act: 'bored', lines: ['发呆也是在陪你','外面的风好舒服','圆滚滚的多可爱'] },
  { keys: ['angel','dirty-dog','shake','flick','cross','sit-up'],
    act: 'rub', lines: ['揉揉脸 舒服～','晃一晃 心情好','蹭蹭你～'] },
  { keys: ['rose','flower','gift-you','gift-flower'],
    act: 'excited', lines: ['送你花花！','我心里也有花','超喜欢你！'] },
  { keys: ['friendship','high-five'],
    act: 'greet', lines: ['我们是好朋友！','击个掌！','友谊天长地久'] },
  { keys: ['write','note-down','draw-circle'],
    act: 'rub', lines: ['记下来记下来','画个圈圈','写小本本上'] },
  { keys: ['peek','look','stare','search','bored','daze','collapse','emo','emm'],
    act: 'bored', lines: ['有点无聊…','陪陪我嘛','你在忙什么呀'] },
  { keys: ['notice-me','shrug','nope'],
    act: 'wronged', lines: ['理理我嘛…','我有点难过','哄哄我好不好'] },
  { keys: ['launch','find-out','wow'],
    act: 'excited', lines: ['哇！发现好东西！','发射爱心！','哇哇哇！'] },
  { keys: ['gnaw','burp'],
    act: 'eat', lines: ['啃啃 真香','嗝…吃得好饱'] },
  { keys: ['strong'],
    act: 'celebrate', lines: ['我最强！','超厉害的！'] },
  { keys: ['twist'],
    act: 'jump', lines: ['扭来扭去～','我转晕啦'] },
  { keys: ['point'],
    act: 'greet', lines: ['你看你看！','指给你看～'] },
  { keys: ['bleh'],
    act: 'hehe', lines: ['略略略～','够不着我吧'] },
];
function pickMemeReaction(gifName) {
  const n = gifName || '';
  for (const g of MEME_MAP) {
    for (const k of g.keys) {
      if (n.indexOf(k) >= 0) return g;
    }
  }
  return null;
}

function scanMemes() {
  memes.length = 0;
  try {
    for (const f of fs.readdirSync(MEME_DIR)) {
      if (/\.(gif|png|jpg|jpeg|webp)$/i.test(f)) memes.push(f);
    }
  } catch (e) {}
  buildSpecialPool();
}

// ---------------------------------------------------------------------------
// 条件表情包（QQ 宠物式）：特定状态只弹特定 GIF，其余时候不出现。
// 脏了才冒「洗澡/脏脏狗」，饿了才弹「要饭/吃饭」，蔫了才弹「无聊/哭」，
// 兴致高弹嗨图、好感高弹贴贴、犯困弹睡觉。优先级高于随机弹窗。
// ---------------------------------------------------------------------------
const MEME_CONDITIONS = [
  // 恢复动作优先：正在洗澡/吃饭时，弹对应的「恢复」表情包（恢复状态显示的 gif）
  { test: (st) => st.state === 'wash', name: '恢复·洗澡',
    pool: (g) => /(shower|bubble|clean|wash|lick)/.test(g) },
  { test: (st) => st.state === 'eat', name: '恢复·吃饭',
    pool: (g) => /(eat|rice|full|crave|smack|cake|noodle)/.test(g) },
  { test: (st) => (st.hunger || 0) >= 76, name: '饿',
    pool: (g) => /(beg|eat|rice|crave|hungry|noodle|cake|smack|lick)/.test(g) },
  { test: (st) => (st.clean != null ? st.clean : 100) <= 40, name: '脏',
    pool: (g) => /(shower|dirty|wipe|wash|bubble)/.test(g) },
  { test: (st) => (st.mood || 50) <= 35, name: '蔫',
    pool: (g) => /(bored|daze|emo|cry|sad|collapse|lying|depressed|frustrated)/.test(g) },
  { test: (st) => (st.mood || 50) >= 65, name: '嗨',
    pool: (g) => /(happy|ha-ha|yay|dance|spin|disco|la-la-la|cheer|good-yay|celebrate|firework)/.test(g) },
  { test: (st) => (st.happiness || 0) >= 90, name: '粘',
    pool: (g) => /(snuggle|love|heart|hug|piggyback|kiss|flower|gift|miss)/.test(g) },
  { test: (st) => /(sleep|sit)/.test(st.state || ''), name: '困',
    pool: (g) => /(sleep|sleepy|tired|night|stay-up|lie|tummy|asleep|drop|faint)/.test(g) },
];
// 条件专用 GIF 集合：只在特定状态出现，随机弹窗时把它们排除掉
let MEME_SPECIAL = null;
function buildSpecialPool() {
  MEME_SPECIAL = new Set();
  for (const c of MEME_CONDITIONS) {
    for (const f of memes) if (c.pool(f)) MEME_SPECIAL.add(f);
  }
}
// 弹窗署名轮流标记（上次署名哪只狗：1=小金毛 2=小白）
let lastMemeDog = 1;
// 恢复轮播：正在洗澡/吃饭时的 GIF 列表（多张按时间逐一播放）
let restorePlaylist = null;   // { state:'wash'|'eat', list:[gif], idx }
function restoreStateOf(st) {
  return (st && (st.state === 'wash' || st.state === 'eat')) ? st.state : null;
}
function buildRestoreList(rs) {
  const conds = MEME_CONDITIONS.filter((c) => c.test({ state: rs }));
  const pool = [];
  const seen = {};
  for (const c of conds) for (const g of memes) {
    if (c.pool(g) && !seen[g]) { seen[g] = 1; pool.push(g); }
  }
  if (!pool.length) pool.push(rs === 'wash' ? 'shower.gif' : 'eat-rice.gif');
  // 打乱：每次进入恢复态顺序都不同
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return pool;
}

function pickConditionalMeme(st) {
  for (const c of MEME_CONDITIONS) {
    if (c.test(st)) {
      const pool = memes.filter(c.pool);
      if (pool.length) return pool[(Math.random() * pool.length) | 0];
    }
  }
  return null;
}

function spawnMeme() {
  if (quietMode || !settings.enabled || !settings.memes) return;
  if (memeWins.length >= 3) return;
  // 恢复态：先定好「只弹恢复 GIF」的轮播，弹窗只从列表逐一取
  const _st0 = petState();
  const _rs = restoreStateOf(_st0);
  if (_rs) {
    if (!restorePlaylist || restorePlaylist.state !== _rs) {
      restorePlaylist = { state: _rs, list: buildRestoreList(_rs), idx: 0 };
      if (process.env.GOOSE_DEBUG) console.log('[goose] restore playlist', _rs, restorePlaylist.list.map((g) => g.split('.')[0]).join('|'));
    }
  } else {
    restorePlaylist = null;
  }
  if (process.env.GOOSE_DEBUG) console.log('[goose] spawn meme window');
  // 署名按发起弹窗的小狗：哪只正在活动（没发呆/没睡）就由它发起；
  // 两只都在活动或都在歇时，严格轮流署名（上次小白下次小金毛，规律可预期）。
  const _sA = _st0;
  const _sB = (deps && deps.getPet2State) ? deps.getPet2State() : {};
  const _act = (st) => st && st.state && st.state !== 'idle' && st.state !== 'sleep';
  const _aA = _act(_sA), _aB = _act(_sB);
  let which;
  if (_aA && !_aB) which = 1;
  else if (_aB && !_aA) which = 2;
  else which = (lastMemeDog === 2) ? 1 : 2;   // 交替
  lastMemeDog = which;
  const MEME_TITLE = (which === 2 ? '小白' : '小金毛') + '留言';
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 300, h = 240;
  const fromLeft = Math.random() < 0.5;
  const targetX = wa.x + Math.round(Math.random() * (wa.width - w - 60) + 30);
  const targetY = wa.y + Math.round(Math.random() * (wa.height - h - 60) + 40);
  const startX = fromLeft ? wa.x - w : wa.x + wa.width;

  const win = new BrowserWindow({
    x: startX, y: targetY, width: w, height: h,
    frame: false, resizable: false, movable: true, skipTaskbar: false,
    alwaysOnTop: true, hasShadow: true, backgroundColor: '#fffdf6',
    webPreferences: { preload: path.join(__dirname, 'preload-meme.js'),
                      nodeIntegration: false, contextIsolation: true, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  let isGif = memes.length > 0 && (Math.random() < 0.75 || !!_rs);
  // 表情包用 base64 内嵌（data: 页面里 file:// 会被 Chromium 拒绝加载，
  // 而且打包进 asar 后 file:// 绝对路径也不可靠 —— base64 两头都稳）。
  let body = '';
  if (isGif) {
    try {
      let gifName = null;
      if (_rs && restorePlaylist) {
        // 恢复期间：按列表逐一播放（多张轮完一圈再从头来，顺序每次进入恢复态都不同）
        gifName = restorePlaylist.list[restorePlaylist.idx % restorePlaylist.list.length];
        restorePlaylist.idx++;
        if (process.env.GOOSE_DEBUG) console.log('[goose] restore meme:', gifName);
      } else {
        gifName = pickConditionalMeme(_st0);
        if (gifName && process.env.GOOSE_DEBUG) console.log('[goose] conditional meme:', gifName, '(' + (MEME_CONDITIONS.find(c => c.pool(gifName)) || {name:'?'}).name + ')');
      }
      if (!gifName) {
        const randPool = memes.filter((g) => !MEME_SPECIAL || !MEME_SPECIAL.has(g));
        gifName = (randPool.length ? randPool : memes)[(Math.random() * (randPool.length ? randPool : memes).length) | 0];
      }
      const gifPath = path.join(MEME_DIR, gifName);
      // 图、动作、台词三者呼应：先做表情对应的动作，再说一句应景的话
      const hit = pickMemeReaction(gifName);
      if (hit) {
        sendToPet({ type: 'act', act: hit.act });
        const line = hit.lines[(Math.random() * hit.lines.length) | 0];
        sendToPet({ type: 'say', text: line, ms: 2000 });
        if (process.env.GOOSE_DEBUG) console.log('[goose] meme', gifName, '->', hit.act, line);
      }
      const b64 = fs.readFileSync(gifPath).toString('base64');
      const mime = /\.png$/i.test(gifPath) ? 'image/png'
                 : /\.jpe?g$/i.test(gifPath) ? 'image/jpeg'
                 : /\.webp$/i.test(gifPath) ? 'image/webp' : 'image/gif';
      body = `<img src="data:${mime};base64,${b64}"
        style="width:100%;height:100%;object-fit:contain;background:#fff;">`;
    } catch (e) { isGif = false; }
  }
  if (!body) {
    body = `<div style="padding:20px;font-family:'PingFang SC',sans-serif;font-size:15px;font-weight:600;color:#141414;line-height:1.9;">${MEME_NOTES[Math.floor(Math.random() * MEME_NOTES.length)]}</div>`;
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#fff;overflow:hidden;border-radius:16px;border:2.5px solid #141414;}
    body{display:flex;height:100vh;}
    .bar{position:fixed;top:0;left:0;right:0;height:30px;background:#141414;display:flex;align-items:center;
         justify-content:space-between;padding:0 10px;font:12px 'PingFang SC';color:#fff;border-bottom:2px solid #141414;user-select:none;}
    .bar b{font-weight:700;letter-spacing:1px;}
    .close{width:22px;height:22px;border-radius:50%;background:#fff;color:#141414;border:2px solid #141414;cursor:pointer;
           font:bold 13px sans-serif;display:flex;align-items:center;justify-content:center;line-height:1;
           padding:0;margin:0;flex:none;}
    .content{flex:1;margin-top:30px;display:flex;align-items:center;justify-content:center;}
  </style></head><body>
    <div class="bar"><b>${MEME_TITLE}</b><button class="close">×</button></div>
    <div class="content">${body}</div>
    <script>
      document.querySelector('.close').onclick = () => {
        window.memeBridge && window.memeBridge.close();   // 被关 → 狗生气
        window.close();
      };
      // 留言弹窗 5 秒后自动关闭（不触发"被关→狗生气"）
      setTimeout(() => { window.close(); }, 5000);
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // 滑入动画
  let sx = startX;
  const slide = setInterval(() => {
    sx += (targetX - sx) * 0.18;
    if (Math.abs(sx - targetX) < 2) { sx = targetX; clearInterval(slide); }
    if (!win.isDestroyed()) win.setPosition(Math.round(sx), targetY);
  }, 16);
  win.on('closed', () => {
    clearInterval(slide);
    if (memeCloseTimer) clearTimeout(memeCloseTimer);
    const i = memeWins.indexOf(win);
    if (i >= 0) memeWins.splice(i, 1);
  });
  // 留言弹窗 5 秒后自动关闭（主进程兜底；页面里也有一份 window.close）
  let memeCloseTimer = setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 5000);
  memeWins.push(win);
  // 弹窗出现在狗身旁或屏幕中下部（提示音已删除）
}

// 弹窗被关闭 → 狗生气（渲染端播放 wrong/大叫，主进程短暂拽光标报复）
ipcMain.on('meme:close', () => {
  sendToPet({ type: 'angry' });
  bark(3);
});

// ---------------------------------------------------------------------------
// 戳它反击：渲染端连点 3 次（或一次长按）触发报复
// ---------------------------------------------------------------------------
let pokeCount = 0;
let pokeWindow = 0;
ipcMain.on('goose:action', (_e, msg) => {
  if (!msg || !settings.enabled) return;
  if (msg.type === 'poke') {
    const now = Date.now();
    if (now - pokeWindow > 10000) pokeCount = 0;   // 10 秒窗口
    pokeWindow = now;
    pokeCount += 1;
    sendToPet({ type: 'bark', times: 1 });
    if (pokeCount >= 3) {
      pokeCount = 0;
      sendToPet({ type: 'angry' });
      chaseCursor(3);                              // 报复：追光标 3 秒
    }
  }
});

// 报复追逐：3 秒内把光标拽向狗并快速抖动
let chaseUntil = 0;
function chaseCursor(secs) {
  chaseUntil = Date.now() + secs * 1000;
  if (process.env.GOOSE_DEBUG) console.log('[goose] chase for ' + secs + 's');
  bark(3);
}
let lastChaseMoveAt = 0;
function tickChase() {
  // 追光标 30Hz 足够平滑，同样省一半子进程开销
  const now = Date.now();
  if (now - lastChaseMoveAt < 33) return;
  lastChaseMoveAt = now;
  if (now < chaseUntil) {
    const p = dogPos();
    moveCursor(p.x + (Math.random() * 40 - 20), p.y - 10 + (Math.random() * 30 - 15));
    sendToPet({ type: 'chase' });
  } else if (chaseUntil && Date.now() >= chaseUntil) {
    chaseUntil = 0;
    sendToPet({ type: 'release' });
  }
}

// ---------------------------------------------------------------------------
// 微型剧本（线条小狗 IP 风格的小剧场：动作 + 台词，新增屏幕活动种类）
// ---------------------------------------------------------------------------
const SKITS = [
  { name: '追尾巴', steps: [['act','spin'],['act','spin'],['say','晕啦晕啦～'],['act','sit'],['say','转晕了 坐一会儿']] },
  { name: '犯困', steps: [['act','sit'],['say','好困呀…'],['act','sleep'],['say','呼…呼…'],['act','jump'],['say','吓我一跳！']] },
  { name: '挖宝', steps: [['act','scratch'],['say','这里好像埋着什么…'],['act','excited'],['say','挖到宝啦！']] },
  { name: '偷看', steps: [['act','walk'],['say','嘿嘿 去偷偷看看'],['act','wrong'],['say','被发现了！我什么都没干！']] },
  { name: '锻炼', steps: [['act','exercise'],['say','锻炼一下！'],['act','hehe'],['say','身体棒棒的！']] },
  { name: '哼歌', steps: [['act','dance'],['say','哼哼～啦啦啦'],['act','hehe'],['say','嘿嘿 今天心情好']] },
  { name: '大扫除', steps: [['act','celebrate'],['say','桌面干干净净！'],['act','greet'],['say','心情超好！']] },
  { name: '讨饭', steps: [['act','hungry'],['say','饿啦 给口饭饭嘛'],['act','rub'],['say','有吃的吗…']] },
];
let skit = null;
function tickSkit(now) {
  if (!skit) return;
  if (now < skit.until) return;
  const step = skit.steps[skit.i];
  if (!step) { skit = null; return; }
  if (step[0] === 'say') {
    sendToPet({ type: 'say', text: step[1], ms: 1600 });
    skit.until = now + 1700;
  } else {
    sendToPet({ type: 'act', act: step[1] });
    skit.until = now + 1300;
  }
  skit.i++;
}
function playSkit() {
  // 由调度器触发：调度器自己已隔了足够时间（scheduleNext 的 5s 冷却），
  // 这里只做类型开关与占用检查，不再看 lastActAt（它刚被调度器设置，会误拦）。
  if (skit || quietMode || !settings.skit || !settings.enabled) return;
  if (process.env.GOOSE_FAST !== '1' && Math.random() < 0.55) return;  // 一半概率跳过，保持新鲜
  skit = { steps: SKITS[(Math.random() * SKITS.length) | 0].steps, i: 0, until: 0 };
  if (process.env.GOOSE_DEBUG) console.log('[goose] skit:', skit.steps.length, 'steps');
}

// ---------------------------------------------------------------------------
// 随机行为调度器
// ---------------------------------------------------------------------------
let schedTimer = null;
let lastActAt = 0;
function scheduleNext() {
  const base = { 1: 35, 2: 22, 3: 15 }[settings.aggression] || 22;
  const fast = process.env.GOOSE_FAST === '1' ? 6 : 1;   // 测试加速（默认关闭）
  // 恢复期间（洗澡/吃饭）：间隔缩短，让恢复 GIF 按时间逐一出现
  const rsNow = restoreStateOf(petState());
  const rm = rsNow ? 0.25 : 1;
  // 第一次行为来得快一点（启动 ~4-9 秒就闹一次，别让用户干等半分钟）
  const first = lastActAt === 0 ? 0.32 : 1;
  const quietMul = quietLevel === 'quiet' ? 4 : 1;   // quiet：捣蛋间隔 ×4 ≈ 概率 ×0.25（§24/§36）；dnd 已短路全停
  const delay = ((base * 0.6 + Math.random() * base * 0.8) * 1000 * rm * first * quietMul) / fast;
  if (schedTimer) clearTimeout(schedTimer);
  schedTimer = setTimeout(() => {
    const rsNow2 = restoreStateOf(petState());
    if (settings.enabled && Date.now() - lastActAt > (rsNow2 ? 2500 : 5000)) {
      lastActAt = Date.now();
      if (rsNow2) {
        // 恢复期间：只弹对应恢复 GIF，按时间逐一播放（间隔已被上面缩短）
        spawnMeme();
      } else {
        const roll = Math.random();
        if (process.env.GOOSE_DEBUG) console.log('[goose] act roll=' + roll.toFixed(2) + ' enabled=' + settings.enabled + ' steal=' + settings.stealMouse + ' memes=' + settings.memes);
        if (roll < 0.28) playSkit();                  // 微型剧本：追尾巴/犯困/挖宝/偷看…
        else if (roll < 0.56) stealCursor();
        else if (roll < 0.78) spawnMeme();
        else if (roll < 0.90) bark(1 + Math.floor(Math.random() * 2));
        else chaseCursor(2);
      }
    }
    scheduleNext();
  }, delay);
}

// ---------------------------------------------------------------------------
// 长按 ESC 退出（Desktop Goose 同款）
// ---------------------------------------------------------------------------
let escStart = 0;
function setupEscQuit() {
  try {
    globalShortcut.register('Escape', () => {
      const now = Date.now();
      if (escStart === 0) {
        escStart = now;
        // 1.2 秒内没有再次触发（松开）就取消累计
        setTimeout(() => { if (Date.now() - escStart > 100) escStart = 0; }, 1200);
      } else if (now - escStart >= 3000) {
        app.quit();                                  // 长按 3 秒退出
      }
    });
  } catch (e) { /* 注册失败（快捷键被占用）不影响主功能 */ }
}

// ---------------------------------------------------------------------------
// 60Hz 主循环钩子（由 main.js 每 tick 调用）
// ---------------------------------------------------------------------------
let lastFpAt = 0;
function tick(now) {
  tickSteal();
  tickChase();
  tickSkit(now);
  if (settings.footprints && now - lastFpAt > 500) { lastFpAt = now; dropFootprint(); }
}

// ---------------------------------------------------------------------------
// 托盘菜单扩展（main.js 把菜单项合并进托盘）
// ---------------------------------------------------------------------------
function trayItems() {
  const item = (label, key) => ({
    label, type: 'checkbox', checked: !!settings[key],
    click: (mi) => { settings[key] = mi.checked; saveSettings(); },
  });
  return [
    { label: '捣蛋行为', enabled: false },
    item('叼鼠标', 'stealMouse'),
    item('表情包弹窗', 'memes'),
    item('汪汪叫', 'bark'),
    item('留脚印', 'footprints'),
    item('微型剧本', 'skit'),
    { type: 'separator' },
    { label: '捣蛋频率', enabled: false },
    { label: '佛系（少闹）', type: 'radio', checked: settings.aggression === 1, click: () => { settings.aggression = 1; saveSettings(); } },
    { label: '正常', type: 'radio', checked: settings.aggression === 2, click: () => { settings.aggression = 2; saveSettings(); } },
    { label: '疯狂（多闹）', type: 'radio', checked: settings.aggression === 3, click: () => { settings.aggression = 3; saveSettings(); } },
    { type: 'separator' },
    { label: '关掉全部捣蛋', click: () => { settings.enabled = false; saveSettings(); } },
    { label: '立即开始捣蛋', click: () => { settings.enabled = true; saveSettings(); lastActAt = 0; scheduleNext(); } },
  ];
}

// ---------------------------------------------------------------------------
// 启动入口
// ---------------------------------------------------------------------------
function setupGoose(_deps) {
  deps = _deps;
  loadSettings();
  scanMemes();
  createFootprintWindow();
  setupEscQuit();
  scheduleNext();
  if (process.env.GOOSE_DEBUG) console.log('[goose] setup OK, memes:', memes.length);
}

module.exports = { setupGoose, tick, trayItems, setQuiet, setQuietLevel };
