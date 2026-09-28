'use strict';
/* =============================================================================
   小金毛桌宠 —— Electron 主进程
   -----------------------------------------------------------------------------
   职责划分（一句话）：**主进程管「这块窗口在屏幕上的哪里」，渲染进程管「狗在
   自己窗里怎么动」。** 狗的水平速度由页面里的状态机算出来（walk 82 单位/秒
   之类），每 100ms 汇报一次；这里把它换算成屏幕像素，用 60Hz 的定时器把窗口
   推着走。页面那边在桌面模式下把 pet.x 钉死在窗内中央，于是看起来就是「狗在
   屏幕上走」—— 页面完全不用知道自己在屏幕的哪个位置。

   两个窗口：
     · 宠物窗   index.html?mode=pet —— 透明、无边框、置顶、不进任务栏
     · 控制台窗 console.html        —— 动作按钮 + 开关 + 设置

   鼠标穿透：透明区域必须能把点击漏给底下的应用，否则一块 266×460 的透明窗口
   会挡住桌面图标。做法是 win.setIgnoreMouseEvents(true, {forward:true})，
   页面用 elementFromPoint 判断光标是不是落在狗身上，落上就关掉穿透
   （见下面 'pet:hover'）。forward 保证穿透状态下仍能收到 mousemove。
   ============================================================================= */

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const goose = require('./goose-main');  // 线条小狗 · Desktop Goose 风格捣蛋模块
const { V2Runtime } = require('./core'); // V2 新系统运行时（状态/调度/存档）
// 渲染端错误可见化（规范 §34 错误处理）：渲染进程报错一律进主进程日志，不再静默
app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (_ev, level, message, line, sourceId) => {
    if (level >= 2) console.error('[renderer:' + level + ']', String(sourceId || '').split('/').pop() + ':' + line, message);
  });
});
let v2 = null;                            // whenReady 里实例化（userData 路径要 app ready 后才有）

// ---------------------------------------------------------------------------
// 路径
//   两种运行形态只差一个目录，用一个 PAGE_DIR 抹平：
//     · 开发（npm start）：代码在 desktop-pet/app/，页面在上一级 desktop-pet/index.html
//     · 打包（.app）      ：代码与页面同在 Contents/Resources/app/ 下（见 tools/build_app.py）
//   之所以要显式区分：`path.join(__dirname, '..')` 在 .app 里会指到 Contents/Resources/，
//   那里没有 index.html —— 页面会白屏，而且是静默的，很难查。
// ---------------------------------------------------------------------------
const IS_PACKAGED = app.isPackaged;
const APP_DIR = __dirname;                             // src/
const RENDERER_DIR = path.join(__dirname, 'renderer'); // 所有页面在 src/renderer/
const ASSET_DIR = path.join(__dirname, '..', 'assets'); // 项目根 assets/（动画/素材/表情包）
const PET_PAGE = path.join(RENDERER_DIR, 'index.html');       // 宠物页（含注入的骨架）
const CONSOLE_PAGE = path.join(RENDERER_DIR, 'console.html');
const EASTER_PAGE = path.join(RENDERER_DIR, 'easter-egg.html');
const BALL_PAGE = path.join(RENDERER_DIR, 'desk-ball.html');   // 桌面上那颗小球
const GOAL_PAGE = path.join(RENDERER_DIR, 'desk-goal.html');   // 左右两个球门
// 托盘图标。**macOS 用模板图**（纯黑 + 透明，系统会按菜单栏明暗自动反色）；
// Windows 没有模板图这套（setTemplateImage 在那边是空操作），纯黑图标在深色
// 任务栏上等于隐形 —— 所以 Windows 换彩色图标（从 app/assets/icon.png 缩出来）。
// 托盘图标：**macOS 用表情包彩色图**（线条小狗「好的」小鸡毛挥手，透明底），
// 不按模板图反色（setTemplateImage(false)），深浅色菜单栏都显示原色。
const ICON_PATH = path.join(ASSET_DIR,
  process.platform === 'darwin' ? 'tray-meme.png' : 'tray-win.png');

// Windows 上要显式声明「我是谁」，否则任务栏/通知会把窗口归到一个无名进程下。
// 用的就是 macOS 那边 Info.plist 里的同一个 bundle id，两边对得上。
if (process.platform === 'win32') app.setAppUserModelId('com.linedog.line-dog-pet');

// 开发版与 .app 版共用同一份设置：userData 默认按 app 名字走（productName 一改
// 两边就分叉，「我的设置跑哪去了」会变成一个反复出现的问题）。这里钉死成一个目录。
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'line-dog-pet'));
} catch (e) { /* 极端情况下拿不到 appData 就用 Electron 默认的，不影响使用 */ }

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'desktop-pet.json');

// 构建标记（只改这一行）：控制台底部会显示，用来确认「你现在跑的是哪一版」——
// 版本号一直是 1.0.0，光看版本分不出新旧，上一次就为此多折腾了一轮。
const BUILD_STAMP = '0924-1512';

// 与页面里的常量保持一致（index.html: BASE_H / VIEW_W / VIEW_H）
const BASE_H = 200;
const RATIO = 300 / 281;
const PAD_X = 44;      // 宠物盒左右各留一点。**必须和 index.html 的 PET_PAD_X 一致**
                       // —— 两者一起决定窗口比狗盒宽多少，也就是气泡的横向空间。
                       // 26 → 44：气泡按狗的视觉中心居中，各姿态中心有偏移（坐/跑最
                       // 明显），窗口太窄时气泡会被窗口边缘切掉；44 之后不再被切。
const FOOT = 6;        // 脚底到窗口下沿的余量（给投影留位置）

// ---- 起跳 / 头顶空间 / 气泡：同一件事的三个面，必须一起算 ----
// 约束链是这样的（每一条都是实测过的，别单独改其中一个）：
//   1) 气泡要「跟着起跳全程可见」→ 狗跳到最高点时，气泡还得在它头顶之上。
//   2) 窗口必须装得进工作区（否则 yTop/yBottom 夹取区间反转）。
// 于是：head = jumpApex + BUBBLE_H + HEAD_PAD，winH = boxH + head + FOOT。
//
// **起跳峰值封顶**是 200% 能用的前提：按比例跳的话，200% 时狗盒高 400px、峰值 380px，
// 窗口至少要 400 + (380 + 380+40) + 6 = 1206px，890px 的工作区根本装不下。
// 封顶 JUMP_MAX 之后，大狗跳得相对矮一点（200% 时 160px = 0.4 个身高），换来 200% 可用。
const JUMP_RATIO = 0.95;                 // 起跳峰值 = 0.95 个盒子高（未封顶时）
const JUMP_MAX = 160;                    // 起跳峰值上限（px）—— 见上面那段说明
const BUBBLE_H = 40;                     // 气泡本身占的高度（固定 13px 字号，一行约 33 + 缝）
const jumpApex = (scale) => Math.min(Math.round(BASE_H * scale * JUMP_RATIO), JUMP_MAX);
// 窗口头顶那一段到底要留多高？**够「起跳 + 气泡」就行**：
//   起跳最高点狗被抬起 jumpApex → 气泡还要在它头顶 → 再加气泡高。
// 以前是 head = jumpApex + room（room 里又是一条 jumpApex），等于白留了
// 一整条起跳高度；用户要求把窗口调矮一点，这里砍掉那一条。
// HEAD_PAD 是留给「狗跳到最高点同时说话」的呼吸量：那时气泡离窗口顶还有这么多。
const HEAD_PAD = 44;
const headRoomFor = (scale) => jumpApex(scale) + BUBBLE_H + HEAD_PAD;

// 窗口最小宽度：气泡最长 180px，而**字号固定 13px、不随狗缩放**，所以小尺寸下窗口
// 也得留够 —— 否则 1% 时窗口只有 90px，气泡必然被窗口边缘切掉。
const MIN_WIN_W = 184;

// 可调大小的范围：用户要的是 1% ~ 200%。下限是定值；**上限还要受屏幕高度约束**，
// 由 maxScale() 算出来（本机 890px 工作区下正好是 2.00，见那里的分段解）。
const SCALE_MIN = 0.01;
const SCALE_MAX_HARD = 2.0;

const DEFAULTS = {
  scale: 1,            // 大小 SCALE_MIN ~ maxScale()（页面里 pet.scale）
  speedMul: 1,         // 速度倍率 0.5 ~ 2
  groundOffset: 8,     // 旧版站立高度，保留用于迁移，不再由控制台直接控制
  rangeTopPct: 5,      // 小狗整体活动范围的上边界（工作区高度百分比）
  rangeBottomPct: 95,  // 小狗整体活动范围的下边界（工作区高度百分比）
  rangeLeftPct: 0,     // 左边界（工作区宽度百分比）
  rangeRightPct: 100,  // 右边界（工作区宽度百分比）
  auto: true,          // 自动活动
  follow: false,       // 跟随鼠标
  alwaysOnTop: true,
  autoStart: false,    // 登录系统后自动启动桌宠
  clickThrough: true,  // 空白处鼠标穿透
  clickThroughDog: false, // 连小狗身也鼠标穿透（开启后无法右键小狗打开控制台）
  roam: true,          // 允许它自己走动
  fall: true,          // 坠落模式：松手后掉到屏幕底部（关掉就停在原地不掉）
  ballSerious: false,  // 踢球小游戏：认真赛模式（球更快、踢完不庆祝）
  hunger: true,        // 会饿：饱腹度随时间下降（关掉就一直是满的）
  bubble: true,        // 对话气泡开关（关掉 = 完全不说话）
  easterEgg: true,     // 连续摸头十次的彩蛋开关
  food: 0,             // 食材库存（做饭用）：上限 1，耗尽就不能做饭（金毛那份）
  actFreq: 0.7,        // 动作切换频率倍率（默认 0.7 = 动作停留更久、换得慢）
  x: null,             // 记住的窗口左沿（屏幕坐标）
  y: null,             // 记住的窗口上沿（竖直位置也是漫游出来的）
  consoleOpen: false,
  console2Open: false, // 小白的控制台是不是开着（两只狗各记一份）
  consoleTarget: 1,        // 控制台默认操作目标：1=小金毛 2=小白（记住上次操作的那只）
  // 小白（第二只狗）自己的状态：亲密度与兴致各记一份 —— 两只狗的关系互相独立，
  // 摸了一只另一只不该跟着变。x/y 是它自己的窗口位置。
  // 后面那一批是**每只狗各一份的设置**（见 PER_DOG_KEYS）：null = 还没分家，
  // 载入时就地固化成小金毛当时的值，之后两只各改各的、互不影响。
  pet2: { intimacy: 5, mood: 56, x: null, y: null,
          scale: null, speedMul: null, rangeTopPct: null, rangeBottomPct: null,
          rangeLeftPct: null, rangeRightPct: null,
          auto: null, roam: null, follow: null, fall: null,
          clickThrough: null, clickThroughDog: null, alwaysOnTop: null, hunger: null,
          bubble: null,      // 对话气泡开关
          easterEgg: null,   // 连续摸头十次彩蛋开关
          actFreq: null,     // 动作切换频率倍率
          food: null },        // 食材库存（0/1，每只各一份）
};

// 控制台按钮的合法动作白名单。**加了按钮就要在这里加名字** —— 少了会被
// console:act 的 `ACTIONS.includes(act)` 直接丢掉，按钮点了没反应，而且
// 不报错、不进日志，只能靠肉眼发现。
const ACTIONS = ['pet', 'hungry', 'greet', 'laugh', 'scratch', 'walk', 'run',
                 'jump', 'spin', 'dance', 'celebrate', 'excited',
                 'cry', 'rub', 'fart', 'bored', 'wrong', 'wronged', 'poor',
                 'sit', 'sleep', 'treat', 'home',
                 // 2026-09-23：嘿嘿（积极）、锻炼（日常）、馋（对方做饭时反应）
                 'hehe', 'exercise', 'crave',
                 'deleteFile',
                 // 2026-09-21 新增：做饭 + 两只狗的互动触发
                 //   findPup/hugPup  = 小金毛去找小白     （小白那头看不到）
                 //   findJin/hugJin  = 小白去找小金毛     （小金毛那头看不到）
                 //   danceTogether   = 两只一起跳舞
                 'cook', 'findPup', 'hugPup', 'findJin', 'hugJin',
                 'chatPup', 'chatJin', 'danceTogether',
                 'goOut',
                 // 2026-09-22 安慰类：comfortPup = 小金毛去安慰小白；comfortJin = 小白去安慰小金毛
                 'comfortPup', 'comfortJin',
                 // 给食材（做饭的前置）
                 'giveFood',
                 // 2026-09-24 小游戏：打开踢球小游戏（不是给狗播的动作，
                 // 主进程直接开一扇游戏窗，所以下面 console:act 里要单独拦一下）
                 'ballGame'];

// 「两只狗互动」：谁触发、用哪段双狗片段、跑多久、互动多久
const MEET_KINDS = {
  findJin: { seeker: 2, clip: 'meetPlayJin', state: 'meetPlay', kind: 'play',
             say: '我去找小金毛！' },
  findPup: { seeker: 1, clip: 'meetPlayPup', state: 'meetPlay', kind: 'play',
             say: '我去找小白！' },
  hugJin:  { seeker: 2, clip: 'meetHugJin',  state: 'meetHug',  kind: 'hug',
             say: '我去找小金毛贴贴～' },
  hugPup:  { seeker: 1, clip: 'meetHugPup',  state: 'meetHug',  kind: 'hug',
             say: '我去找小白贴贴～' },
  // 找对方聊天：寻方跑过去后，双狗片段会一直循环到整组对白播完。
  // 双狗片段统一在小白窗口播放，每句都带说话者名字，避免只有气泡分不清是谁。
  chatPup: { seeker: 1, clip: 'chatPup', state: 'meetChat', kind: 'chat1',
             say: '我去找小白聊天～',
             chats: [
               [
                 { who: 1, text: '小金毛：幸福是什么呀？', ms: 1800, hold: 2100 },
                 { who: 2, text: '小白：幸福是一只小狗！', ms: 1800, hold: 2100 },
                 { who: 1, text: '小金毛：那我们是两只小狗～', ms: 1900, hold: 2200 },
                 { who: 2, text: '小白：所以幸福加倍啦！', ms: 1800, hold: 2100 },
               ],
               [
                 { who: 1, text: '小金毛：云朵是什么味道？', ms: 1800, hold: 2100 },
                 { who: 2, text: '小白：棉花糖味！', ms: 1800, hold: 2100 },
                 { who: 1, text: '小金毛：那我们去咬一口～', ms: 1900, hold: 2200 },
                 { who: 2, text: '小白：记得带我回来呀！', ms: 1800, hold: 2100 },
               ],
               [
                 { who: 1, text: '小金毛：我尾巴一直在摇。', ms: 1800, hold: 2100 },
                 { who: 2, text: '小白：因为它很开心呀！', ms: 1800, hold: 2100 },
                 { who: 1, text: '小金毛：那它为什么开心？', ms: 1900, hold: 2200 },
                 { who: 2, text: '小白：因为看见我了呀～', ms: 1800, hold: 2100 },
               ],
               [
                 { who: 1, text: '小金毛：小白，你喜欢什么？', ms: 1900, hold: 2200 },
                 { who: 2, text: '小白：喜欢你追着我跑！', ms: 1800, hold: 2100 },
                 { who: 1, text: '小金毛：那我现在开始追～', ms: 1900, hold: 2200 },
                 { who: 2, text: '小白：等等，先数三下！', ms: 1800, hold: 2100 },
               ],
             ] },
  chatJin: { seeker: 2, clip: 'chatJin', state: 'meetChat', kind: 'chat2',
             say: '我去找小金毛聊天～',
             chats: [
               [
                 { who: 2, text: '小白：小金毛，你闻到了吗？', ms: 1900, hold: 2200 },
                 { who: 1, text: '小金毛：闻到啦，是阳光的味道！', ms: 1900, hold: 2200 },
                 { who: 2, text: '小白：那我们去追阳光吧～', ms: 1900, hold: 2200 },
                 { who: 1, text: '小金毛：走呀，尾巴先出发！', ms: 1800, hold: 2100 },
               ],
               [
                 { who: 2, text: '小白：小金毛，你会飞吗？', ms: 1800, hold: 2100 },
                 { who: 1, text: '小金毛：不会呀，但我会蹦！', ms: 1800, hold: 2100 },
                 { who: 2, text: '小白：能蹦到月亮上吗？', ms: 1900, hold: 2200 },
                 { who: 1, text: '小金毛：你接着我就行！', ms: 1800, hold: 2100 },
               ],
               [
                 { who: 2, text: '小白：今天有什么好消息？', ms: 1900, hold: 2200 },
                 { who: 1, text: '小金毛：我刚刚打了个滚！', ms: 1900, hold: 2200 },
                 { who: 2, text: '小白：这算什么好消息？', ms: 1800, hold: 2100 },
                 { who: 1, text: '小金毛：说明今天适合开心！', ms: 1900, hold: 2200 },
               ],
               [
                 { who: 2, text: '小白：我有一点点困了。', ms: 1800, hold: 2100 },
                 { who: 1, text: '小金毛：那靠着我睡吧。', ms: 1800, hold: 2100 },
                 { who: 2, text: '小白：你会偷偷走开吗？', ms: 1800, hold: 2100 },
                 { who: 1, text: '小金毛：不会，我一直在这儿。', ms: 1900, hold: 2200 },
               ],
             ] },
  danceTogether: { seeker: 2, clip: 'meetDance', state: 'meetDance', kind: 'dance',
                   say: '一起跳舞吧！' },
  // 两只狗一起跑到中间，再播「我们出去玩啦」双狗片段。
  goOut: { seeker: 1, clip: 'goOut', state: 'meetGoOut', kind: 'goOut',
           bothRun: true, say: '我们出去玩啦～', sayAtClip: true },
  // 安慰类：寻方跑过去陪着对方（夹在互动系统里，一样是位图双狗片段）
  comfortPup: { seeker: 1, clip: 'comfortPup', state: 'meetComfort', kind: 'comfort1',
                say: '我去陪陪小白…' },
  comfortJin: { seeker: 2, clip: 'comfortJin', state: 'meetComfort', kind: 'comfort2',
                say: '我去陪陪小金毛…' },
};
// 每种互动的总时长（毫秒）= **片段播一遍** + **抱住之后定格一会儿**：
//   找X玩   = 2.0 秒（20 帧 × 100ms，播一遍）+ 4.0 秒定格 = 6.2 秒
//   找X贴贴 = 2.1 秒（8 帧，时长 100/500/1000ms 混合，播一遍）+ 4.0 秒定格 = 6.1 秒
//   一起跳舞 = 0.8 秒一轮，循环 4 轮 = 3.2 秒（这段不是「抱住」，照旧循环）
// 秒数来自 app/assets/pet2/clips.json，改了素材记得回来对一下。
//   找X玩  = 片段一遍 2.0s + 定格 1 秒 = 3.0s；找X贴贴 = 2.1s + 1s = 3.1s
const MEET_MS = { play: 3000, hug: 3100, dance: 3200, goOut: 2000,
                  // 安慰：播一遍就收尾。
                  //   comfort1 = 安慰小白（小金毛过去，片段 2.4s）→ 播完**定格 1 秒**
                  //   comfort2 = 安慰小金毛（小白过去，片段 0.88s）→ 用户要求**播三遍**、
                  //              且不停顿：0.88 × 3 = 2.64 秒，给 2.63 秒（停在第 3 遍
                  //              的最后一帧上，正好是抱住的画面）就收尾
                  comfort1: 3400, comfort2: 2630 };

// 小白（第二只狗）控制台按钮的合法动作 —— 就是它有真动画的那 8 个
// （帧序列在 app/assets/pet2/，由 tools/extract-pet2.py 从用户给的 GIF 处理出来）。
// 「加按钮就要在这里加名字」，少了会被直接丢掉。
// 小白与**小金毛同一份页面**，所以动作白名单也照抄一整份：有帧表的状态播帧，
// 还没做素材的（散步/坐下/哭哭…）先回落到静态姿势，等素材补上再进帧表。
const PET2_ACTIONS = ACTIONS;

// ---------------------------------------------------------------------------
// 设置：单一真源在主进程（页面的 localStorage 在桌面模式下不再作准）
// ---------------------------------------------------------------------------
let settings = Object.assign({}, DEFAULTS);

let SAVE_ERR = null;

// 每项设置都有自己的合法区间，进来一律夹一道。设置文件是人手也能改的纯文本，
// 而且跨版本可能留着过时的值 —— 与其让一个离谱的 scale（比如 0.51）悄悄把狗缩小
// 一半、还查不出是谁写的，不如在入口就把它拉回合法范围并说一声。
// scale **不在**这张表里：它的上限随屏幕高度变（maxScale()），写死一份迟早
// 和 geometry() 里的实际夹取区间对不上。下面单独处理。
const RANGES = {
  speedMul: [0.5, 2],
  actFreq: [0.35, 2.5],     // 动作切换频率倍率（>1 = 每个动作停留更短）
  groundOffset: [0, 500],
  // 上下边界：**允许超出 0~100%**（用户要求「边角可以到屏幕外」）。
  // 100% = 工作区高；-100% 就是「整屏高度之上」，200% 是「整个屏高之下」。
  rangeTopPct: [-100, 99],
  rangeBottomPct: [1, 200],
  // 左右边界：和上下同一套口径（狗盒子的左/右沿落在工作区宽度的百分之几），
  // 同样允许越界 —— 负数就是跑到屏幕左边外面、超过 100% 就是右边外面。
  rangeLeftPct: [-100, 99],
  rangeRightPct: [1, 200],
};

function sanitize(obj) {
  const out = Object.assign({}, DEFAULTS, obj);
  Object.keys(RANGES).forEach((k) => {
    const [lo, hi] = RANGES[k];
    const n = Number(out[k]);
    if (!Number.isFinite(n)) {
      console.warn('[pet] 设置 %s 不是数字（%s），回退到默认 %s', k, out[k], DEFAULTS[k]);
      out[k] = DEFAULTS[k];
    } else if (n < lo || n > hi) {
      console.warn('[pet] 设置 %s=%s 超出 [%s, %s]，已夹到边界', k, n, lo, hi);
      out[k] = clamp(n, lo, hi);
    }
  });
  {
    const lo = SCALE_MIN, hi = maxScale();
    const n = Number(out.scale);
    if (!Number.isFinite(n)) {
      console.warn('[pet] 设置 scale 不是数字（%s），回退到默认 %s', out.scale, DEFAULTS.scale);
      out.scale = DEFAULTS.scale;
    } else if (n < lo || n > hi) {
      console.warn('[pet] 设置 scale=%s 超出 [%s, %s]，已夹到边界', n, lo, hi);
      out.scale = clamp(n, lo, hi);
    }
  }
  {
    const top = Number(out.rangeTopPct);
    const bottom = Number(out.rangeBottomPct);
    if (Number.isFinite(top) && Number.isFinite(bottom) && bottom <= top + 1) {
      out.rangeBottomPct = clamp(top + 1, RANGES.rangeBottomPct[0], RANGES.rangeBottomPct[1]);
    }
  }
  ['auto', 'follow', 'alwaysOnTop', 'autoStart', 'clickThrough', 'clickThroughDog', 'roam', 'fall', 'hunger', 'easterEgg',
   'ballSerious',
   'consoleOpen'].forEach((k) => {
    out[k] = !!out[k];
  });
  if (out.x !== null && out.x !== undefined && !Number.isFinite(Number(out.x))) out.x = null;
  if (out.y !== null && out.y !== undefined && !Number.isFinite(Number(out.y))) out.y = null;
  out.console2Open = !!out.console2Open;
  out.consoleTarget = (Number(out.consoleTarget) === 2) ? 2 : 1;
  // 小白那份状态：缺字段就拿默认值补齐（旧版本的设置文件里没有 pet2，
  // 不能因此让它 NaN 一路传到窗口坐标里去）。
  {
    const d = DEFAULTS.pet2;
    const p = (out.pet2 && typeof out.pet2 === 'object') ? out.pet2 : {};
    const numOr = (v, fb) => (v === null || v === undefined || !Number.isFinite(Number(v)))
      ? fb : Number(v);
    out.pet2 = {
      intimacy: Math.max(0, numOr(p.intimacy, d.intimacy)),
      mood: clamp(numOr(p.mood, d.mood), 0, 100),
      x: numOr(p.x, null),
      y: numOr(p.y, null),
    };
    // 每只一份的那批键：这里只做「原样搬过来」，范围夹取统一交给
    // resolvePerDogSettings()（它才知道 maxScale/活动边界这些联动关系）。
    PER_DOG_KEYS.forEach((k) => {
      out.pet2[k] = (p[k] === undefined) ? null : p[k];
    });
  }
  return out;
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') settings = sanitize(obj);
  } catch (e) { /* 首次运行没有文件，用默认值 */ }
  resolvePerDogSettings();
}

// 每只狗各一份的设置 —— 「分家」就发生在这里：
//   · 还是 null 的键（老设置文件 / 第一次运行）就地固化小金毛当时的值；
//   · 小白自己那份 scale / 速度 / 活动边界按**它自己的**上限与区间夹一遍。
// 之后两只狗各改各的：改小金毛的大小不会再把小白一起改掉。
function resolvePerDogSettings() {
  // **先给 pet2 一份自己的对象**：settings 是从 DEFAULTS 浅拷贝来的，
  // 嵌套对象是共享引用 —— 直接往 settings.pet2 上写会把 DEFAULTS 一起改掉。
  settings.pet2 = Object.assign({}, DEFAULTS.pet2, settings.pet2 || {});
  PER_DOG_KEYS.forEach((k) => {
    // 食材是**消耗品**，不能「从小金毛那份继承」——没分家时它应该是 0，
    // 否则第一次启动小白会平白得到小金毛背包里的那份。
    if(k === 'food') return;
    const cur = settings.pet2[k];
    if (cur === null || cur === undefined) {
      const base = settings[k];
      settings.pet2[k] = (typeof base === 'number') ? Number(base) : !!base;
    }
  });
  // ① 小白那份的标量先各自夹到合法区间（速度、上下活动边界）
  settings.pet2.speedMul = clamp(Number(settings.pet2.speedMul) || DEFAULTS.speedMul,
                                 RANGES.speedMul[0], RANGES.speedMul[1]);
  // 两个新设置：两条狗各一份；顶层那份是小金毛的
  settings.actFreq = clamp(Number(settings.actFreq) || 1, RANGES.actFreq[0], RANGES.actFreq[1]);
  settings.pet2.actFreq = clamp(Number(settings.pet2.actFreq) || 1,
                                RANGES.actFreq[0], RANGES.actFreq[1]);
  // 食材每只一份，夹到 0/1
  settings.food = Math.max(0, Math.min(1, Number(settings.food) || 0));
  settings.pet2.food = Math.max(0, Math.min(1, Number(settings.pet2.food) || 0));
  settings.pet2.rangeLeftPct = clamp(Number(settings.pet2.rangeLeftPct) || 0,
                                     RANGES.rangeLeftPct[0], RANGES.rangeLeftPct[1]);
  settings.pet2.rangeRightPct = clamp(Number(settings.pet2.rangeRightPct) || 100,
                                      RANGES.rangeRightPct[0], RANGES.rangeRightPct[1]);
  if (settings.pet2.rangeRightPct - settings.pet2.rangeLeftPct < 1) {
    settings.pet2.rangeRightPct = Math.min(RANGES.rangeRightPct[1],
                                           settings.pet2.rangeLeftPct + 1);
  }
  settings.pet2.rangeTopPct = clamp(Number(settings.pet2.rangeTopPct) || 0,
                                    RANGES.rangeTopPct[0], RANGES.rangeTopPct[1]);
  settings.pet2.rangeBottomPct = clamp(Number(settings.pet2.rangeBottomPct) || 100,
                                       RANGES.rangeBottomPct[0], RANGES.rangeBottomPct[1]);
  if (settings.pet2.rangeBottomPct - settings.pet2.rangeTopPct < 1) {
    settings.pet2.rangeBottomPct = Math.min(RANGES.rangeBottomPct[1],
                                            settings.pet2.rangeTopPct + 1);
  }
  PER_DOG_BOOLS.forEach((k) => { settings.pet2[k] = !!settings.pet2[k]; });
  // ② 最后才夹体型 —— 上限取决于屏幕和上面刚定下来的活动边界，顺序反了会用到旧边界。
  invalidateMaxScale();
  settings.scale = clamp(Number(settings.scale) || DEFAULTS.scale, SCALE_MIN, maxScale(1));
  settings.pet2.scale = clamp(Number(settings.pet2.scale) || DEFAULTS.scale,
                              SCALE_MIN, maxScale(2));
}

let saveTimer = null;
function saveSettings() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); }
    catch (e) {
      if (!SAVE_ERR) { SAVE_ERR = e.message; console.warn('[pet] 设置写盘失败:', e.message); }
    }
  }, 250);
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------------------
// 每只狗各一份的设置 —— 两个控制台各改各的，互不影响。
//   每只一份：大小 / 速度 / 上下活动范围 / 自动活动 / 到处走走 / 跟随鼠标 /
//             坠落模式 / 空白处点击穿透 / 总是置顶
//   全局共用：开机自启动（整台机器就一个）、会饿（只属于小金毛，小白压根不吃）
//   还有窗口位置 x/y —— 那个本来就分开存（settings.x/y 与 settings.pet2.x/y）。
// 存法：小金毛的仍然是顶层那批键（老设置文件一个字都不用改），小白的放在
// settings.pet2.<同名键>。载入时若还是 null 就**就地固化**成小金毛当时的值，
// 于是从旧版本升级上来小白不会突然变样，而从那一刻起两只狗各走各的。
// ---------------------------------------------------------------------------
const PER_DOG_KEYS = ['scale', 'speedMul', 'rangeTopPct', 'rangeBottomPct',
                      'auto', 'roam', 'follow', 'fall', 'clickThrough', 'clickThroughDog', 'alwaysOnTop',
                      'hunger', 'bubble', 'easterEgg', 'actFreq',
                      'food'];           // 食材：每只一份（用户要求分开）
const PER_DOG_BOOLS = ['auto', 'roam', 'follow', 'fall', 'clickThrough', 'clickThroughDog', 'alwaysOnTop',
                       'hunger', 'bubble', 'easterEgg'];

function dogSetting(target, key) {
  if (target !== 2) return settings[key];
  const v = settings.pet2 ? settings.pet2[key] : undefined;
  // 兜底：理论上载入后就已经固化了，这里再保一层，免得 null 漏进几何计算
  return (v === null || v === undefined) ? settings[key] : v;
}
function setDogSetting(target, key, value) {
  if (target === 2) settings.pet2[key] = value;
  else settings[key] = value;
}
// 托盘那种「一键两只」的开关用这个；控制台不走这里（各改各的）
function setBothDogs(key, value) {
  setDogSetting(1, key, value);
  setDogSetting(2, key, value);
}

// ---------------------------------------------------------------------------
// 几何：由 scale 推出宠物盒与窗口尺寸
//   窗口高 = 盒子高 + 头顶空间 + 脚底余量
//   头顶空间要装得下：物理起跳的弧线（v²/2g ≈ 180px @scale1）+ 台词气泡
// ---------------------------------------------------------------------------
// 某个 scale 下的窗口高度 —— geometry() 与自检共用这一份算式，别写两遍
// （maxScale() 是反过来解这个不等式，也必须跟着它走）。
function winHeightFor(scale) {
  const boxH = Math.round(BASE_H * scale);
  return boxH + headRoomFor(scale) + FOOT;
}

function geometry(target) {
  const scale = clamp(Number(dogSetting(target, 'scale')) || 1, SCALE_MIN, maxScale(target));
  const boxH = Math.round(BASE_H * scale);
  const boxW = Math.round(boxH * RATIO);
  // 头顶空间只有 head 一个量（活动边界那套自己按百分比算窗口位置，
  // 不再需要把「窗口顶伸出工作区多少」单独带出去）。
  const head = headRoomFor(scale);
  return { scale, boxH, boxW, head,
           winW: Math.max(boxW + PAD_X * 2, MIN_WIN_W), winH: winHeightFor(scale) };
}

// 工作区（已排除 Dock / 菜单栏）。
// **加一层 1 秒的缓存**：它在 tick 里被 yTop/yBottom/roamRange 反复问，而
// getPrimaryDisplay() 是同步的原生调用 —— 不缓存就是每帧 3~4 次跨进程往返。
// 用 TTL 而不是只靠 'display-metrics-changed'：万一哪次事件没来，1 秒后自愈。
let waCache = null, waAt = 0, waDisplayId = null;
function workArea() {
  const now = Date.now();
  let display;
  try {
    // 以宠物窗口当前所在显示器为准。只用主屏 workArea 时，副屏或跨屏位置
    // 会套错边界，动作切换后看起来就像狗自己跑到屏幕外。
    display = (petWin && !petWin.isDestroyed())
      ? screen.getDisplayMatching(petWin.getBounds())
      : screen.getPrimaryDisplay();
  } catch (_e) {
    display = screen.getPrimaryDisplay();
  }
  const id = display.id;
  if (waCache && waDisplayId === id && now - waAt < 1000) return waCache;
  if (waDisplayId !== null && waDisplayId !== id) invalidateMaxScale();
  waDisplayId = id;
  waCache = display.workArea;
  waAt = now;
  return waCache;
}

// 「叫到身边」用的落点：**忽略用户设的下边界**，直接落到屏幕底边。
// 下边界现在可以被拉到屏幕外（用户要求「边角可以到屏幕外」），要是叫回来
// 也按那条线放，狗就会被放到看不见的地方 —— 那这个救命按钮就废了。
function screenFloorWindowY(g, foot){
  const wa = desktopWorkBounds();      // 整张桌面的底边
  return Math.round(wa.y + wa.height - g.winH + foot);
}

// 「松手掉回地面」那条地面的窗口 y。**最多只掉到屏幕底边** —— 下边界现在可以被
// 拉到 100% 以上（屏幕外），照那条线掉的话狗会直接掉出屏幕、找不回来。
// 下边界在屏幕内时仍然按用户设的那条线掉（保持原来的手感）。
function fallGroundY(target){
  const t = target === 2 ? 2 : 1;
  const g = t === 2 ? pet2Geometry() : geometry();
  const foot = t === 2 ? PET2_FOOT : FOOT;
  const bandBot = t === 2 ? pet2VerticalRange(g).maxWindowY : yBottom(g);
  return Math.min(bandBot, screenFloorWindowY(g, foot));
}

// **所有显示器工作区的并集** = 整张桌面。活动范围（上下左右边界）都按它算，
// 于是小狗能走过两块屏之间那条缝、跑到另一块屏上去。
// 以前活动范围是按「狗当前所在的那块屏」算的（workArea()），结果就是
// 「多屏时狗永远出不了自己那块屏」（用户反馈）。单屏时并集 = 那块屏，行为不变。
let deskCache = null, deskAt = 0;
function desktopWorkBounds(){
  const now = Date.now();
  if(deskCache && now - deskAt < 1000) return deskCache;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
  try {
    screen.getAllDisplays().forEach((d) => {
      const a = d.workArea;
      x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y);
      x1 = Math.max(x1, a.x + a.width); y1 = Math.max(y1, a.y + a.height);
      any = true;
    });
  } catch (_e) { any = false; }
  if(!any){ const a = workArea(); x0 = a.x; y0 = a.y; x1 = a.x + a.width; y1 = a.y + a.height; }
  deskCache = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  deskAt = now;
  return deskCache;
}

function configuredVerticalBand(target) {
  const wa = desktopWorkBounds();      // 整张桌面（多屏 = 并集），这样能走到别的屏上
  const topPct = clamp(Number(dogSetting(target, 'rangeTopPct')) || 0,
                       RANGES.rangeTopPct[0], RANGES.rangeTopPct[1]);
  const bottomPct = clamp(Number(dogSetting(target, 'rangeBottomPct')) || 100,
                          RANGES.rangeBottomPct[0], RANGES.rangeBottomPct[1]);
  // **不再夹回工作区**：以前这里有 safeTop / safeBottom 两道「留一点余量」的夹取，
  // 于是不管滑杆怎么拉，狗最多只能贴到屏幕上/下沿、永远出不去。用户要求
  // 「边角可以到屏幕外」，所以这里直接按百分比换算 —— 百分比越界，狗就出屏。
  const topY = wa.y + Math.round(wa.height * topPct / 100);
  const bottomY = wa.y + Math.round(wa.height * bottomPct / 100);
  return { topY, bottomY, height: Math.max(1, bottomY - topY) };
}

// 可调大小的上限。
//   窗口高 = boxH + head + FOOT = boxH + jumpApex + (BUBBLE_H + HEAD_PAD + FOOT)
// 而 jumpApex = min(0.95*boxH, JUMP_MAX) 是**分段**的，所以要分两段解：
//   段 1（还没到封顶）：boxH*(1 + 0.95) + BUBBLE_H + HEAD_PAD + FOOT <= wa.height - 24
//   段 2（已封顶）：     boxH + JUMP_MAX + BUBBLE_H + HEAD_PAD + FOOT <= wa.height - 24
// 它必须装得进工作区 —— 否则 yTop(g) 会跑到 yBottom(g) 下面，夹取区间一反转，
// moveWindowTo 就把窗口拍到一个非法高度，整只狗钻到菜单栏上面去。
// 屏幕大就给到硬顶 SCALE_MAX_HARD（= 2.0，用户要的 200%）。
// 上限要**每只狗各算一份**：两只狗的窗口算式不同（小白没有起跳那一层，
// 但头顶要留气泡），而且各自的活动范围也可能不一样。
let maxScaleCache = { 1: null, 2: null };
function invalidateMaxScale(target) {
  if (target === 1 || target === 2) maxScaleCache[target] = null;
  else { maxScaleCache[1] = null; maxScaleCache[2] = null; }
}
function maxScale(target) {
  const t = target === 2 ? 2 : 1;
  if (maxScaleCache[t] !== null) return maxScaleCache[t];
  const wa = workArea();
  let fit;
  if (t === 2) {
    // 小白跑的是小金毛那张页面：窗口高 = max(金毛那套起跳+气泡, 动画画布高) + 脚底
    //   —— 两条约束各解一个上限，取小的（正好是 max 的反解）
    const limit = wa.height - (BUBBLE_H + HEAD_PAD + FOOT) - 24;
    const boxAtCap2 = JUMP_MAX / JUMP_RATIO;
    const s1b = limit / (BASE_H * (1 + JUMP_RATIO));
    const fitJump = (s1b * BASE_H <= boxAtCap2) ? s1b : (limit - JUMP_MAX) / BASE_H;
    const fitAnim = (wa.height - (8 + FOOT + 24)) / PET2_ANIM_H;
    fit = Math.min(fitJump, fitAnim);
  } else {
    const limit = wa.height - (BUBBLE_H + HEAD_PAD + FOOT) - 24;
    const boxAtCap = JUMP_MAX / JUMP_RATIO;              // 起跳封顶时的盒子高
    const s1 = limit / (BASE_H * (1 + JUMP_RATIO));      // 段 1 解出来的 scale
    fit = (s1 * BASE_H <= boxAtCap)
      ? s1                                               // 还没到封顶就已经装不下
      : (limit - JUMP_MAX) / BASE_H;                     // 封顶之后：winH 只随 boxH 线性长
  }
  // 小狗盒子也必须装得进用户设置的上/下活动边界；范围调窄时自动降低最大体型。
  const bandFit = configuredVerticalBand(t).height / BASE_H;
  const fitted = Math.min(fit, bandFit);
  maxScaleCache[t] = clamp(Math.floor(fitted * 100) / 100, SCALE_MIN, SCALE_MAX_HARD);
  return maxScaleCache[t];
}

// 窗口左沿的允许范围：让狗的脚正好能踩到屏幕左右两边
// 用户设的左右边界：描述「狗盒子的左沿 / 右沿」落在工作区宽度的百分之几。
// 和上下一样**不夹回工作区** —— 拉过头狗就走到屏幕外面。
function configuredHorizontalBand(target){
  const wa = desktopWorkBounds();      // 同上：按整张桌面算，才能跨屏
  const l = clamp(Number(dogSetting(target, 'rangeLeftPct')) || 0,
                  RANGES.rangeLeftPct[0], RANGES.rangeLeftPct[1]);
  const r = clamp(Number(dogSetting(target, 'rangeRightPct')) || 100,
                  RANGES.rangeRightPct[0], RANGES.rangeRightPct[1]);
  return { leftX: wa.x + Math.round(wa.width * l / 100),
           rightX: wa.x + Math.round(wa.width * r / 100) };
}

function roamRange(g) {
  const band = configuredHorizontalBand(1);
  return { min: band.leftX - PAD_X, max: band.rightX - PAD_X - g.boxW };
}

function groundScreenY(g) {
  const wa = workArea();
  return wa.y + wa.height - Number(settings.groundOffset || 0);
}

// 用户设置的上下活动边界描述的是“小狗整体盒子”的顶部与底部，单位是工作区高度
// 的百分比。这里把它换算成窗口上沿的 min/max；自动漫游、跟随、拖拽和坠落
// 全部共用它，所以没有任何一条分支可以把狗送出用户设定的范围。
function verticalRange(g) {
  const band = configuredVerticalBand();
  let { topY, bottomY } = band;

  // maxScale() 已按 band.height 限制体型；这里的兜底只防旧配置/极小范围，
  // 绝不让窗口范围反转。
  if (bottomY - topY < g.boxH) {
    const mid = (topY + bottomY) / 2;
    topY = Math.round(mid - g.boxH / 2);
    bottomY = Math.round(mid + g.boxH / 2);
  }

  const dogTopInWin = g.winH - FOOT - g.boxH;
  const dogBottomInWin = g.winH - FOOT;
  return {
    topY: Math.round(topY),
    bottomY: Math.round(bottomY),
    minWindowY: Math.round(topY - dogTopInWin),
    maxWindowY: Math.round(bottomY - dogBottomInWin),
  };
}

function yTop(g) { return verticalRange(g).minWindowY; }
function yBottom(g) { return verticalRange(g).maxWindowY; }

// 光标是否已经落在“狗身”这块可点击区域上。窗口里为了起跳/气泡留了很多透明
// 空间，不能拿整窗 bounds 判断，否则光标刚到窗口边缘就会暂停追随。
function cursorOnPet(c, g) {
  const x0 = roamX + PAD_X;
  const x1 = x0 + g.boxW;
  const y0 = roamY + g.winH - FOOT - g.boxH;
  const y1 = y0 + g.boxH;
  const pad = 6;                       // 给耳朵/爪尖留一点点击余量
  return c.x >= x0 - pad && c.x <= x1 + pad &&
         c.y >= y0 - pad && c.y <= y1 + pad;
}

// 把窗口搬到 (x, y)，同时更新「权威位置」roamX / roamY。
// **所有改窗口位置的地方都走这里** —— 否则状态和真实窗口会分家：下一个 tick
// 会拿旧的 roamX/roamY 把它拽回去，表现得像「怎么拖都弹回来」。
function moveWindowTo(x, y) {
  const g = geometry();
  roamX = clamp(x, roamRange(g).min, roamRange(g).max);
  roamY = clamp(y, yTop(g), yBottom(g));       // 期望位置（窗口坐标，不含移位）
  if (petWin && !petWin.isDestroyed()) {
    const winY = applyDogShift(1, roamY);      // 窗口顶到 macOS 的夹取线之后，改挪狗
    petWin.setBounds({ x: Math.round(roamX), y: Math.round(winY),
                       width: g.winW, height: g.winH });
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
let petWin = null;
let pet2Win = null;
let consoleWin = null;            // 小金毛的控制台
let easterEggWin = null;          // 连续摸头十次后的全屏彩蛋
let farewellQuitting = false;
let tray = null;
let trayMenu = null;              // 自己留着菜单引用，见 createTray() 的说明

const petState = {                // 渲染进程汇报上来的最近一帧状态
  state: 'idle', facing: 1, vx: 0, statusText: '', happiness: 0, hunger: 0,
  satiety: 100, clean: 100, auto: true, follow: false, night: false, snapAt: 0,
  // 性情（见 index.html 的 makeDrives）：mood/strain 是动作调度与状态文案
  // 的外部可见部分；energy 已不再显示，也不参与动作概率。
  mood: 0, strain: 0, why: null, centerX: -1, centerY: -1,
};
let petReady = false;             // 宠物窗的页面脚本跑完并发来 pet:ready 了吗
let pet2Ready = false;            // 第二只小狗页面加载完成

let roamX = 0;                    // 宠物窗左沿的屏幕 x
let roamY = 0;                    // 宠物窗上沿的屏幕 y（竖直位置也漫游）
let roamTargetY = null;           // 竖直漫游的目标高度
let nextYPick = 0;                // 下次重选目标高度的时刻
const VY_RATIO = 0.55;            // 普通漫游的竖直速度比例
const FOLLOW_SPEED = 460;         // 跟随鼠标的屏幕速度 px/s（1x）
const IS_WIN = process.platform === 'win32';
let roamVx = 0;                   // 当前横向意图速度（屏幕 px/s）
let roamSuspended = false;        // 拖动期间挂起
let interactive = false;          // 当前是否处于「可点」状态（关掉穿透）
let pet2X = 0, pet2Y = 0;         // 第二只小狗的窗口坐标
let pet2TargetY = null, pet2NextYPick = 0, pet2Dir = 1;   // pet2Dir 只作初值，方向以页面汇报为准
let pet2Moving = false, pet2LastDir = 0;
let pet2Dragged = false;          // 正被拎在手上：这段时间窗口完全由光标驱动
let pet2Suspended = false;        // 拖动/坠落期间挂起自主漫游与追随
let pet2Falling = false;          // 松手之后正在掉回地面
let pet2FallVy = 0;               // 坠落速度（屏幕 px/s）
let pet2Interactive = false;      // 小白这扇窗当前是不是「可点」（关掉穿透）
let pet2SaveAt = 0;               // 上次把它的亲密度/兴致写盘的时刻
// 脚底余量必须和页面里的 PET_FOOT 一致（页面那份是 6）：现在小白跑的就是
// index.html 那套逻辑，布局常数得跟它对齐。
const PET2_FOOT = 6;
// 小白也要说台词，头顶必须留出气泡那一截。它没有起跳动画，只留气泡就够
//（第一只是 jumpApex + BUBBLE_H，见 geometry()）。56 是「两行 13px 台词 +
// 内边距 + 小尾巴」实测需要的量；这是渲染层（index.html / 小白皮肤）共用的气泡高度。
const PET2_BUBBLE_H = 56;
// 窗口最小宽度：气泡最长 180px、字号固定不随狗缩放，窗口太窄气泡就会被切掉。
// 与第一只的 MIN_WIN_W 同一个理由、同一个数。
const PET2_MIN_W = 184;
// 动画画布的最大尺寸（**显示像素 @ scale=1**）：由 tools/extract-pet2.py 的输出得来，
// 加了新动作要回来更新这两个数（现在的最大值是「睡觉」那张床的场景）：
//   jump 209x319 / bored 279x200 / excited 224x209 / celebrate 239x277 /
//   hungry 408x272 / fall 250x222 / dance 230x234 / sleep 456x456
const PET2_ANIM_W = 456, PET2_ANIM_H = 456;
// 追随鼠标时「狗身中心」停在光标下方多少像素 —— 沿用改版前的手感，
// 免得窗口为了气泡长高之后整只狗看起来往下掉了一截。
const PET2_FOLLOW_DY = 33;
// 小白自己的状态（页面每 100ms 汇报一帧）。**与第一只各记一份** ——
// 两只狗的亲密度/兴致不能互相串。
// 小白的最近一帧状态：**字段与小金毛的 petState 完全一致**（同一份页面在跑）
const pet2State = {
  state: 'idle', facing: 1, vx: 0, happiness: 0, hunger: 0, mood: 56, clean: 100,
  strain: 0, why: null, centerX: -1, centerY: -1,
  auto: true, follow: false, night: false, snapAt: 0,
};

function createPetWindow() {
  const g = geometry();
  const range = roamRange(g);
  const wa = workArea();

  roamX = (settings.x === null || settings.x === undefined)
    ? clamp(wa.x + Math.round(wa.width * 0.30), range.min, range.max)
    : clamp(Number(settings.x), range.min, range.max);
  // 竖直位置也记：上次它溜到半空，这次就从半空接着来（不然每次开都在地上）
  roamY = (settings.y === null || settings.y === undefined)
    ? yBottom(g)
    : clamp(Number(settings.y), yTop(g), yBottom(g));
  roamTargetY = null;

  petWin = new BrowserWindow({
    width: g.winW,
    height: g.winH,
    x: Math.round(roamX),
    y: Math.round(roamY),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    acceptFirstMouse: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-pet.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 关键：失焦时不能降频，否则狗一转身背对眼睛就卡住
      backgroundThrottling: false,
    },
  });

  petWin.loadURL(pathToFileURL(PET_PAGE).href + '?mode=pet');
  petWin.once('ready-to-show', () => { showPetWindow(petWin); applyAlwaysOnTop(); });
  petWin.on('closed', () => { petWin = null; });
  petWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  setIgnoreMouse(mouseShouldPassThrough(1));   // 起步先按设置来
}

// ---------------------------------------------------------------------------
// 第二只小狗「小白」：独立透明窗口 + 第一只那一套基础功能。
//   这里管窗口这一侧：漫游、追随、拖动、坠落、鼠标穿透、置顶、位置记忆；
//   页面**就是 index.html 那一份**（?mode=pet&skin=puppy）：状态机、需求系统、
//   台词、摸头/双击/右键全同，只是渲染层换成位图逐帧（见 index.html 的小白皮肤）。
//   两边靠 preload-pet2.js 的 pet2:* 通道说话，消息名与金毛那份一一对应。
//   **刻意不跟第一只共用通道**：主进程是「按通道分发」的，共用的话两扇窗的
//   hover / drag 会互相覆盖（摸小白会变成摸小金毛）。动作帧之后再补，
//   控制台里那几个动作先给占位效果。
// ---------------------------------------------------------------------------
function pet2Geometry(){
  // 大小用**小白自己那份**（两个控制台各改各的），上限也按它自己的屏幕约束算
  const scale = clamp(Number(dogSetting(2, 'scale')) || 1, SCALE_MIN, maxScale(2));
  const boxH = Math.max(16, Math.round(BASE_H * scale));
  // 盒子宽必须与页面里那份一致（index.html: boxW = boxH * RATIO，RATIO=300/281）——
  // 小白的位图是按自己的比例画在这个盒子里的，盒子本身沿用金毛那套布局比例。
  const boxW = Math.max(12, Math.round(boxH * RATIO));
  // 窗口要同时装下两件事（和小金毛共用同一份页面之后，这两条缺一不可）：
  //   ① 小金毛那套：起跳弧线 + 气泡（页面里的物理起跳会真的把狗抬起来）
  //   ② 小白的动画画布：它比狗盒子高/宽（睡觉那张床 456x456 @100%），
  //      画布底边压在脚底线上、水平以狗身为中心
  const headP1 = headRoomFor(scale);   // 小金毛那套「起跳 + 气泡」的头顶空间
  const animW = Math.round(PET2_ANIM_W * scale);
  const animH = Math.round(PET2_ANIM_H * scale);
  const headAnim = Math.max(0, animH - boxH) + 8;
  const head = Math.max(headP1, headAnim, PET2_BUBBLE_H + 8);
  // 画布比狗盒子宽出来的部分要平均分到两侧，所以左右内边距一起加宽
  // —— 页面把狗摆在 pet.x = padX 处、画布以狗身为中心，必须对得上。
  const padX = Math.max(PAD_X, Math.round(PAD_X + Math.max(0, animW - boxW) / 2) + 4);
  return { scale, boxH, boxW, padX,
           winW: padX * 2 + boxW,
           winH: boxH + head + PET2_FOOT };
}

function pet2Range(g){
  // 与小金毛的 roamRange 同算法（夹的是狗盒子，不是整扇窗），只是用
  // **小白自己那套左右边界**。
  const band = configuredHorizontalBand(2);
  return { min: band.leftX - g.padX, max: band.rightX - g.padX - g.boxW };
}

function pet2VerticalRange(g){
  const band = configuredVerticalBand(2);   // 小白自己的上下活动边界
  let topY = band.topY, bottomY = band.bottomY;
  if(bottomY - topY < g.boxH){
    const mid = (topY + bottomY) / 2;
    topY = Math.round(mid - g.boxH / 2);
    bottomY = Math.round(mid + g.boxH / 2);
  }
  const dogTopInWin = g.winH - PET2_FOOT - g.boxH;
  const dogBottomInWin = g.winH - PET2_FOOT;
  return {
    topY: Math.round(topY),
    bottomY: Math.round(bottomY),
    minWindowY: Math.round(topY - dogTopInWin),
    maxWindowY: Math.round(bottomY - dogBottomInWin),
  };
}

function sendAllPet(msg){               // 捣蛋模块发给两只启用的狗
  sendPet(msg);
  sendPet2(msg);
}

function sendPet2(msg){
  if(pet2Win && !pet2Win.isDestroyed()) pet2Win.webContents.send('pet2:command', msg);
}

function setPet2IgnoreMouse(on){
  if(!pet2Win || pet2Win.isDestroyed()) return;
  pet2Win.setIgnoreMouseEvents(!!on, { forward: true });
}

// 狗盒子顶边在窗口里的 y（窗口上方那一段是留给气泡的）
function pet2DogTopInWin(g){ return g.winH - PET2_FOOT - g.boxH; }

function syncPet2Geometry(){
  if(!pet2Win || pet2Win.isDestroyed()) return;
  const g = pet2Geometry();
  const r = pet2Range(g), vr = pet2VerticalRange(g);
  pet2X = clamp(pet2X, r.min, r.max);
  pet2Y = clamp(pet2Y, vr.minWindowY, vr.maxWindowY);
  pet2Win.setBounds({ x: Math.round(pet2X), y: Math.round(applyDogShift(2, pet2Y)),
                        width: g.winW, height: g.winH });
  // **与小金毛的 geom 完全同名同形**（页面是同一份代码，只是换了画法）：
  // 多给一个 padX —— 小白那张动画画布比狗盒子宽，页面要把狗摆在窗口内更靠里的位置。
  sendPet2({ type: 'geom', scale: g.scale || Number(dogSetting(2, 'scale')),
             boxW: g.boxW, boxH: g.boxH, winW: g.winW, winH: g.winH,
             padX: g.padX, maxScale: maxScale(2) });
}

// 设置变更 → 通知小白那一页。它得知道「自动/漫游/追随」这些开关，
// 一是决定摆不摆走路姿态，二是追随期间要说那句话、并把兴致涨上去。
function pushPet2Settings(){
  // 同样与小金毛的 settings 同名同形（页面按同一套逻辑接）
  sendPet2({
    type: 'settings',
    scale: Number(dogSetting(2, 'scale')),
    speedMul: Number(dogSetting(2, 'speedMul')),
    auto: !!dogSetting(2, 'auto'),
    follow: !!dogSetting(2, 'follow'),
    hunger: !!dogSetting(2, 'hunger'),
    bubble: dogSetting(2, 'bubble') !== false,
    easterEgg: dogSetting(2, 'easterEgg') !== false,
    actFreq: clamp(Number(dogSetting(2, 'actFreq')) || 1,
                   RANGES.actFreq[0], RANGES.actFreq[1]),
  });
}

function createSecondPetWindow(){
  const g = pet2Geometry();
  const r = pet2Range(g), vr = pet2VerticalRange(g);
  const saved = settings.pet2 || {};
  // 上次退出时它待在哪儿，这次就接着来（位置也是「状态记忆」的一部分）
  pet2X = Number.isFinite(Number(saved.x))
    ? clamp(Number(saved.x), r.min, r.max)
    : clamp(roamX + geometry().winW + 18, r.min, r.max);
  pet2Y = Number.isFinite(Number(saved.y))
    ? clamp(Number(saved.y), vr.minWindowY, vr.maxWindowY)
    : vr.maxWindowY;
  pet2TargetY = pet2Y;
  pet2NextYPick = Date.now() + 1800;
  pet2Ready = false;
  pet2Dragged = false; pet2Suspended = false; pet2Falling = false; pet2FallVy = 0;
  pet2Interactive = false;

  pet2Win = new BrowserWindow({
    width:g.winW, height:g.winH, x:Math.round(pet2X), y:Math.round(pet2Y),
    transparent:true, frame:false, resizable:false, movable:false,
    minimizable:false, maximizable:false, fullscreenable:false,
    skipTaskbar:true, hasShadow:false, acceptFirstMouse:false, show:false,
    backgroundColor:'#00000000',
    webPreferences:{
      // 专用的 preload：两扇窗的消息走各自的通道
      preload: path.join(__dirname, 'preload-pet2.js'),
      contextIsolation:true, nodeIntegration:false, sandbox:false,
      backgroundThrottling:false,
    },
  });
  setPet2IgnoreMouse(mouseShouldPassThrough(2));
  // **同一张页面，换皮肤**：小白跑的就是小金毛那份代码（状态机/需求/台词/交互全同），
  // 只是 ?skin=puppy 时把「怎么画」换成位图逐帧（见 index.html 的小白渲染层）。
  pet2Win.loadURL(pathToFileURL(PET_PAGE).href + '?mode=pet&skin=puppy');
  pet2Win.once('ready-to-show', () => {
    if(pet2Win && !pet2Win.isDestroyed()){
      showPetWindow(pet2Win);
      applyAlwaysOnTop();
    }
  });
  pet2Win.webContents.on('did-finish-load', () => {
    pet2Ready = true;
    syncPet2Geometry();
    applyAlwaysOnTop();
    if(pet2Win && !pet2Win.isDestroyed() && !pet2Win.isVisible()) showPetWindow(pet2Win);
  });
  pet2Win.on('closed', () => { pet2Win = null; pet2Ready = false; });
}

let pet2BumpAt = 0;
function tickSecond(){
  if(!pet2Win || pet2Win.isDestroyed() || !pet2Ready) return;
  const now = Date.now();
  const dt = Math.min(0.05, (now - (tickSecond.last || now)) / 1000);
  tickSecond.last = now;
  const g = pet2Geometry();
  const actual = pet2Win.getBounds();
  const r = pet2Range(g), vr = pet2VerticalRange(g);

  // —— **与小金毛的 tick 完全同一套分工**：状态和横向意图速度都由页面给，
  //    这里只负责「按它说的搬窗口」，外加竖直漫游的选点与落地物理。
  const state = pet2State.state;
  const walking = state === 'walk' || state === 'run';
  const pxPerUnit = g.boxW / 300;                       // 舞台单位 → 屏幕像素
  let roamVx = (Number(pet2State.vx) || 0) * pxPerUnit;
  // **必须把「到处走走」也算进来**（小金毛那条就是 settings.roam，我抄的时候漏了）：
  // 少了这一条，关掉「到处走走」它也照样走；连「自动活动」关掉都还在走 ——
  // 两个开关看起来一起失效（用户反馈的正是这个）。
  if(!dogSetting(2, 'roam') || !walking || pet2Suspended || pet2Falling) roamVx = 0;

  // 追随模式保持整窗穿透（金毛那边同一条：追到光标下面也要能点到底下的东西）
  if(dogSetting(2, 'follow') && mouseShouldPassThrough(2) && pet2Interactive){
    pet2Interactive = false;
    setPet2IgnoreMouse(true);
  }

  // 跟随鼠标：把光标在窗口内的坐标发给页面（它的跟随/姿态逻辑要用），50ms 一次
  if(dogSetting(2, 'follow') && now - (tickSecond.cursorAt || 0) >= 50){
    tickSecond.cursorAt = now;
    const c = screen.getCursorScreenPoint();
    sendPet2({ type: 'cursor', x: c.x - pet2X, y: c.y - pet2Y });
  }

  // 拖拽中窗口完全由光标驱动（dragTimer 每 16ms setBounds），两个轴都别插手
  if(pet2Dragged){ pet2X = actual.x; pet2Y = actual.y; return; }
  // 同小金毛：踢球期间的窗口位置由 ballTick 全权负责（要能追到别的屏幕）
  if(ball.on) return;

  // 坠落模式关掉时立刻停住（与金毛的 tick 同一条兜底）
  if(pet2Falling && !dogSetting(2, 'fall')){
    pet2Falling = false;
    pet2FallVy = 0;
    sendPet2({ type: 'stand' });
  }

  let y = pet2Y, moving = false;
  if(pet2Falling){
    const land2 = fallGroundY(2);        // 最多掉到屏幕底边
    pet2FallVy += fallG(g) * dt;
    pet2Y += pet2FallVy * dt;
    if(pet2Y >= land2){
      // 落地：把冲击速度按同一个换算还给页面（它负责压缩回弹那一下）
      const impact = pet2FallVy;
      pet2Y = land2;
      pet2Falling = false;
      pet2FallVy = 0;
      sendPet2({ type: 'land', vy: impact / pxPerUnit });
    }
    y = pet2Y;
  } else if(dogSetting(2, 'follow') && !pet2Suspended){
    // 追光标：对齐页面报上来的「狗身视觉中心」（与金毛同一算法）
    const c = screen.getCursorScreenPoint();
    const dogCX = Number(pet2State.centerX) >= 0 ? Number(pet2State.centerX)
                                                 : g.padX + g.boxW / 2;
    const dogCY = Number(pet2State.centerY) >= 0 ? Number(pet2State.centerY)
                                                 : g.winH - PET2_FOOT - g.boxH / 2;
    const tx = c.x - dogCX, ty = c.y - dogCY;
    const dx = tx - pet2X, dy = ty - pet2Y;
    const dist = Math.hypot(dx, dy);
    if(dist > 4){
      const speed = FOLLOW_SPEED * Number(dogSetting(2, 'speedMul'));
      const step = Math.min(dist, speed * dt);
      pet2X += dx / dist * step;
      pet2Y += dy / dist * step;
      moving = true;
    }
    pet2TargetY = null;
    y = pet2Y;
  } else if(walking && roamVx !== 0){
    // 竖直漫游：自己挑一个高度、慢慢挪过去（金毛那份逻辑）
    // **目标点必须用窗口坐标**（minWindowY/maxWindowY），不能用狗盒子的 topY/bottomY：
    // 后者比窗口坐标整体偏下一个「头顶空间」，挑出来的目标几乎都在窗口下方，
    // 夹取之后狗就永远贴着屏幕底部走（用户反馈：小白不会走到上面）。
    // 小金毛那边是 yTop()/yBottom()，它们本来就是窗口坐标，我用错了对的量。
    if(pet2TargetY === null || (now > pet2NextYPick && Math.abs(pet2Y - pet2TargetY) < 8)){
      const lo = vr.minWindowY, hi = vr.maxWindowY;
      pet2TargetY = lo + Math.random() * Math.max(1, hi - lo);
      pet2NextYPick = now + 2500 + Math.random() * 3500;
    }
    pet2X += roamVx * dt;
    const vy = Math.max(Math.abs(roamVx) * VY_RATIO, (vr.bottomY - vr.topY) / 26);
    pet2Y += clamp(pet2TargetY - pet2Y, -vy * dt, vy * dt);
    moving = true;
    y = pet2Y;
  } else {
    y = pet2Y;
  }

  // 撞到左右边：夹住 + 通知页面转身（方向归页面，它翻 facing / 改 vx）
  if(pet2X <= r.min || pet2X >= r.max){
    const side = pet2X <= r.min ? 'left' : 'right';
    pet2X = clamp(pet2X, r.min, r.max);
    if(now > pet2BumpAt){
      pet2BumpAt = now + 450;
      sendPet2({ type: 'bump', side: side });
    }
  }
  if(!pet2Falling){
    pet2Y = clamp(pet2Y, vr.minWindowY, vr.maxWindowY);
    y = pet2Y;
  }
  pet2X = clamp(pet2X, r.min, r.max);

  const x = Math.round(pet2X); y = Math.round(y);
  if(x !== actual.x || y !== actual.y || g.winW !== actual.width || g.winH !== actual.height){
    pet2Win.setBounds({ x, y: Math.round(applyDogShift(2, y)), width: g.winW, height: g.winH });
  }
  pet2Moving = moving;                  // 只留作排查用，不再往页面发指令
}

// ---------------------------------------------------------------------------
// 两只狗互动：跑过去 → 两只各自的小狗让位 → 小白的窗口播双狗片段 → 复原
//   为什么让小白的窗口当舞台：双狗片段是**位图**，而小金毛那扇窗是矢量骨架
//   （它只能画自己）。所以规则很简单 —— **小金毛那扇窗躲起来，小白这扇窗换片**。
// ---------------------------------------------------------------------------
let meet = null;

function meetDogCenter(target){
  // 这扇窗里「狗身中心」的屏幕坐标（主进程侧算，不依赖页面汇报）
  if(target === 2){
    const g = pet2Geometry();
    return { x: pet2X + g.padX + g.boxW / 2,
             y: pet2Y + g.winH - PET2_FOOT - g.boxH / 2 - dogShift[2],
             padX: g.padX, boxW: g.boxW, boxH: g.boxH, g: g };
  }
  const g = geometry();
  return { x: roamX + PAD_X + g.boxW / 2,
           y: roamY + g.winH - FOOT - g.boxH / 2 - dogShift[1],
           padX: PAD_X, boxW: g.boxW, boxH: g.boxH, g: g };
}

// 把某只狗的视觉中心放到指定屏幕坐标。退出时让两只狗从各自位置
// 一起跑到中点，最后再切到双狗告别片段。
function placeDogCenter(target, centerX, centerY){
  if(target === 2){
    if(!pet2Win || pet2Win.isDestroyed()) return;
    const g = pet2Geometry();
    const r = pet2Range(g), vr = pet2VerticalRange(g);
    pet2X = clamp(centerX - (g.padX + g.boxW / 2), r.min, r.max);
    pet2Y = clamp(centerY - (g.winH - PET2_FOOT - g.boxH / 2),
                  vr.minWindowY, vr.maxWindowY);
    pet2Win.setBounds({ x: Math.round(pet2X), y: Math.round(applyDogShift(2, pet2Y)),
                        width: g.winW, height: g.winH });
  }else{
    if(!petWin || petWin.isDestroyed()) return;
    const g = geometry();
    const r = roamRange(g);
    roamX = clamp(centerX - (PAD_X + g.boxW / 2), r.min, r.max);
    roamY = clamp(centerY - (g.winH - FOOT - g.boxH / 2), yTop(g), yBottom(g));
    moveWindowTo(roamX, roamY);        // moveWindowTo 内部会处理移位
  }
}

function moveDogCenterToward(target, targetX, targetY, dt){
  const cur = meetDogCenter(target);
  const dx = targetX - cur.x, dy = targetY - cur.y;
  const dist = Math.hypot(dx, dy);
  if(dist < 0.5) return;
  const speed = FOLLOW_SPEED * Number(dogSetting(target, 'speedMul'));
  const step = Math.min(dist, speed * Math.max(0, dt));
  placeDogCenter(target, cur.x + dx / dist * step, cur.y + dy / dist * step);
}

function meetWinFor(target){
  return target === 2 ? pet2Win : petWin;
}

function startMeet(act, opts){
  opts = opts || {};
  const cfg = MEET_KINDS[act];
  if(!cfg || meet) return false;
  // 正在踢球 → 双人互动直接让路。**不能反过来把球收掉** —— 那正是用户看到的
  // 「小游戏被双人动作打断」（自动互动 25~50 秒就会考虑一次）。
  // 想演双人动作就先右键点球收起来。
  if(ball.on) return false;
  if(!pet2Win || pet2Win.isDestroyed()) return false;
  // 两只狗始终同屏显示，不再有「隐藏另一只」的分支。
  const hidden = [];
  const bothRun = !!(opts.bothRun || cfg.bothRun);
  const seeker = cfg.seeker;              // 1 = 小金毛去，2 = 小白去
  const other = seeker === 2 ? 1 : 2;
  const saved = { 1: null, 2: null };
  {
    const b1 = petWin && !petWin.isDestroyed() ? petWin.getBounds() : null;
    const b2 = pet2Win.getBounds();
    saved[1] = b1; saved[2] = b2;
  }
  const chat = cfg.chats && cfg.chats.length
    ? cfg.chats[(Math.random() * cfg.chats.length) | 0]
    : (cfg.chat || null);
  meet = { act: act, cfg: cfg, seeker: seeker, other: other, saved: saved,
           hidden: hidden.slice(), bothRun: bothRun, quitAfter: !!opts.quitAfter,
           chat: chat, phase: 'seek', t0: Date.now(), timer: null };
  // **只有双人互动才改兴致**（用户要求：单人动作不需要明显变化），
  // 放在这里而不是「自动触发」那条路上 —— 这样从控制台手动点也一样生效。
  // 数值按用户定的来：
  //   找X玩 / 找X贴贴 / 一起跳舞 → 双方各 +3
  //   安慰                     → 只有「被安慰的那只」+10，去安慰的那只不加
  if(cfg.kind === 'play' || cfg.kind === 'hug' || cfg.kind === 'dance' ||
     cfg.kind === 'chat1' || cfg.kind === 'chat2'){
    bumpBothMood(3);
  }else if(cfg.kind === 'comfort1' || cfg.kind === 'comfort2'){
    const low = (seeker === 2) ? 1 : 2;      // 被安慰的那只（没去的那只）
    bumpMood(low, 10);
  }
  // 追逐期间：两边的自主漫游都挂起，窗口完全由这里驱动
  roamSuspended = true;
  pet2Suspended = true;
  // **让寻方摆出「跑」的姿态**（页面那边会固定住这个状态不自动切走）——
  // 只搬窗口不换姿态是「平移」，用户一眼就能看出来。
  const face = () => {
    const participants = bothRun ? [1, 2] : [seeker];
    participants.forEach((target) => {
      const cur = meetDogCenter(target);
      const dst = meetDogCenter(bothRun ? (target === 1 ? 2 : 1) : other);
      const dir = (dst.x - cur.x) >= 0 ? 1 : -1;
      const msg = { type: 'driven', state: 'run', dir: dir };
      if(target === 2) sendPet2(msg); else sendPet(msg);
    });
  };
  face();
  // 互动类动作的出发台词。`sayAtClip` 的动作（目前是退出前的 goOut）
  // 要等两只狗真正汇合、双狗画面开始后再触发；否则会一边分头跑、一边提前告别。
  if(cfg.say && !cfg.sayAtClip){
    const targets = bothRun ? [1, 2] : [seeker];
    targets.forEach((target) => {
      if(target === 2) sendPet2({ type: 'say', text: cfg.say, ms: 1600 });
      else sendPet({ type: 'say', text: cfg.say, ms: 1600 });
    });
  }
  // 寻方的状态：竞速时用 run，其它互动也用 run（页面那边由 driven 固定住）
  if(bothRun){
    sendPet({ type: 'driven', state: 'run', dir: 1 });
    sendPet2({ type: 'driven', state: 'run', dir: -1 });
  }else if(seeker === 2) sendPet2({ type: 'driven', state: 'run', dir: 1 });
  else sendPet({ type: 'driven', state: 'run', dir: 1 });

  const beginMeetClip = () => {
    if(!meet) return;
    meet.phase = 'meet';
    // 聊天动作的持续时间由这一轮选中的对白决定：最后一句说完后再多留一拍才收尾。
    const chat = meet.chat || [];
    const chatMs = chat.length ? meetChatDuration(chat) : 0;
    meet.until = Date.now() + (chatMs ? chatMs + 220 : (MEET_MS[cfg.kind] || 4000));
    // 两只狗各自的小狗让位：小金毛那扇窗藏起来，小白的窗口换成双狗片段。
    if(petWin && !petWin.isDestroyed()) petWin.hide();
    // 先解除「驾驶」状态，再让小白切到双狗片段
    sendPet({ type: 'driven', state: null });
    sendPet2({ type: 'driven', state: null });
    sendPet2({ type: 'meetClip', clip: cfg.clip, state: cfg.state });
    // 退出前的 goOut：等汇合后的「一起出去玩」画面切进来，再在双狗窗口说告别台词。
    if(cfg.sayAtClip && cfg.say) meetChatSay(cfg.say, 1600);
    // 双狗片段在小白的窗口里，两份台词都走那扇窗的气泡；
    // 说话者名字已经写在每条文本里。
    if(chat.length){
      clearMeetChatTimers(meet);
      meet.chatTimers = chat.map((line, i) => {
        let at = 180;
        for(let j = 0; j < i; j++) at += Number(chat[j].hold || 1900);
        return setTimeout(() => {
          if(!meet || meet.phase !== 'meet') return;
          meetChatSay(line.text, line.ms || 1800);
        }, at);
      });
    }
    snapshotToConsole();
  };

  const step = () => {
    if(!meet) return;
    const now = Date.now();
    const cur = meetDogCenter(seeker);
    const dst = meetDogCenter(other);
    const dx = dst.x - cur.x, dy = dst.y - cur.y;
    const dist = Math.hypot(dx, dy);
    const speed = FOLLOW_SPEED * (seeker === 2 ? Number(dogSetting(2, 'speedMul'))
                                                : Number(settings.speedMul));
    if(meet.phase === 'seek'){
      const seekMs = now - meet.t0;
      const dt = Math.min(0.05, (now - (meet.lastTick || now)) / 1000);
      meet.lastTick = now;
      if(now - (meet.faceAt || 0) > 400){ meet.faceAt = now; face(); }
      if(bothRun){
        const c1 = meetDogCenter(1), c2 = meetDogCenter(2);
        const gap = Math.hypot(c1.x - c2.x, c1.y - c2.y);
        const tx = (c1.x + c2.x) / 2, ty = (c1.y + c2.y) / 2;
        if(gap <= 36 || seekMs > 15000){
          placeDogCenter(1, tx, ty);
          placeDogCenter(2, tx, ty);
          beginMeetClip();
          return;
        }
        moveDogCenterToward(1, tx, ty, dt);
        moveDogCenterToward(2, tx, ty, dt);
        return;
      }
      // 慢机器 / 慢速度 / 宽屏幕上，6 秒不一定够跑完全程。以前到点就直接
      // 开演，才会出现「还隔着一截就触发」。现在不再到点硬启动：
      // 先逐步加速追赶，实在追太久才对齐位置，确保动画从贴着的状态开始。
      const boost = seekMs > 6000 ? Math.min(2.5, 1 + (seekMs - 6000) / 4000) : 1;
      const stepPx = Math.min(dist, speed * boost * dt);
      if(seeker === 2){
        const g = pet2Geometry();
        const r = pet2Range(g), vr = pet2VerticalRange(g);
        pet2X = clamp(pet2X + (dx / Math.max(1, dist)) * stepPx, r.min, r.max);
        pet2Y = clamp(pet2Y + (dy / Math.max(1, dist)) * stepPx, vr.minWindowY, vr.maxWindowY);
        pet2Win.setBounds({ x: Math.round(pet2X), y: Math.round(applyDogShift(2, pet2Y)),
                        width: g.winW, height: g.winH });
      }else{
        const g = geometry();
        roamX += (dx / Math.max(1, dist)) * stepPx;
        roamY += (dy / Math.max(1, dist)) * stepPx;
        moveWindowTo(roamX, roamY);
      }
      if(dist <= 10){
        beginMeetClip();
        return;
      }
      // 极端情况下（窗口无法继续靠近等）不要让它在远处开演：先把寻方的
      // 狗身中心和对方对齐，再切双狗片段。
      if(seekMs > 15000){
        const seekerCenter = meetDogCenter(seeker);
        const baseX = seeker === 2 ? pet2X : roamX;
        const baseY = seeker === 2 ? pet2Y : roamY;
        const tx = dst.x - (seekerCenter.x - baseX);
        const ty = dst.y - (seekerCenter.y - baseY);
        if(seeker === 2){
          const g = pet2Geometry();
          const r = pet2Range(g), vr = pet2VerticalRange(g);
          pet2X = clamp(tx, r.min, r.max);
          pet2Y = clamp(ty, vr.minWindowY, vr.maxWindowY);
          pet2Win.setBounds({ x: Math.round(pet2X), y: Math.round(applyDogShift(2, pet2Y)),
                        width: g.winW, height: g.winH });
        }else{
          const g = geometry();
          roamX = clamp(tx, roamRange(g).min, roamRange(g).max);
          roamY = clamp(ty, yTop(g), yBottom(g));
          moveWindowTo(roamX, roamY);
        }
        beginMeetClip();
        return;
      }
      return;
    }
    if(meet.phase === 'meet' && now >= meet.until){
      clearMeetChatTimers(meet);
      meet.phase = 'restore';
      if (v2 && v2.engines && v2.engines.relationship) v2.engines.relationship.recordMeet(meet.act);   // V2：互动完成 → 好感+
      // 退出动作：双狗片段播完后直接退出，不做复原动画。
      if(meet.quitAfter){
        clearInterval(meetTimer);
        meetTimer = null;
        meet = null;
        app.quit();
        return;
      }
      sendPet2({ type: 'meetEnd' });
      // 复原：**两只狗都出现在互动发生的位置**（用户要求），一左一右贴着站，
      // 不再各自回原位。
      if(petWin && !petWin.isDestroyed()) showPetWindow(petWin);
      if(pet2Win && !pet2Win.isDestroyed()){
        const g2 = pet2Geometry();
        const g1 = geometry();
        const baseY2 = pet2Y, baseY1 = roamY;
        // 小白先站到互动点（它本来就是舞台，位置没动），金毛站到它左边
        pet2Win.setBounds({ x: Math.round(pet2X), y: Math.round(baseY2),
                            width: g2.winW, height: g2.winH });
        const leftX = Math.round(pet2X + g2.padX - g1.boxW / 2 - PAD_X);
        roamX = leftX;
        roamY = baseY2 + (g2.winH - PET2_FOOT - g2.boxH / 2)
                        - (g1.winH - FOOT - g1.boxH / 2);
        moveWindowTo(roamX, roamY);
      }
          roamSuspended = false;
      pet2Suspended = false;
      meet = null;
      snapshotToConsole();
      clearInterval(meetTimer);
      meetTimer = null;
    }
  };
  if(meetTimer) clearInterval(meetTimer);
  meetTimer = setInterval(step, 16);
  return true;
}
let meetTimer = null;
function meetBusy(){ return !!meet; }

// ---------------------------------------------------------------------------
// 两只狗的「相处」结算与自动触发
//   条件（用户要求）：
//     · 找X玩 / 找X贴贴 —— 任何兴致都可能，触发后双方兴致 +
//     · 一起跳舞       —— 双方兴致都 ≥ 50 才可能，触发后双方兴致 +
//     · 安慰对方       —— 对方兴致低（< 40）时触发，只给低的那只补兴致
//     · 做饭           —— 双方都肚子饿（饿 ≥ 50）且有食材：扣食材，两只都加饱腹度
// ---------------------------------------------------------------------------
function meetSay(target, text, ms){
  const msg = { type: 'say', text: text, ms: ms || 1600 };
  if(target === 2) sendPet2(msg); else sendPet(msg);
}
// “找对方聊天”沿用双狗片段窗口：两条狗都在同一个画面里，所以对白统一发到
// 小白窗口显示。第一句留一点入场时间，后续按 hold 依次接话。
function meetChatDuration(lines){
  let at = 180;
  (lines || []).forEach((line) => { at += Number(line.hold || 1900); });
  return at;
}
function meetChatSay(text, ms){
  if(pet2Win && !pet2Win.isDestroyed()) sendPet2({ type: 'say', text: text, ms: ms || 1800 });
}
function clearMeetChatTimers(state){
  if(!state || !state.chatTimers) return;
  state.chatTimers.forEach((timer) => clearTimeout(timer));
  state.chatTimers = [];
}
// 给两只狗结算（页面里的需求系统负责真正改写，主进程只发指令）
function bumpBothMood(amount){
  sendPet({ type: 'drive', mood: Number(amount) || 0 });
  sendPet2({ type: 'drive', mood: Number(amount) || 0 });
}
function bumpMood(target, amount){
  const msg = { type: 'drive', mood: Number(amount) || 0 };
  if(target === 2) sendPet2(msg); else sendPet(msg);
}
function feedBoth(satiety){
  sendPet({ type: 'drive', satiety: Number(satiety) || 0 });
  sendPet2({ type: 'drive', satiety: Number(satiety) || 0 });
}
// 食材是**每只一份**：foodCount(1) 是小金毛的，foodCount(2) 是小白的
function foodCount(target){ return Math.max(0, Math.min(1, Number(dogSetting(target, 'food')) || 0)); }

// 给食材（控制台按钮）
function giveFood(target){
  if(foodCount(target) >= 1){
    meetSay(target, '拿不下啦～', 1700);          // 这只已经有一个了
  }else{
    setDogSetting(target, 'food', 1); saveSettings();
    meetSay(target, target === 2 ? '谢谢食材！我这就去做' : '谢谢食材！我去做饭', 1800);
  }
  snapshotToConsole();
}

// 把文件移动到系统回收站，并让指定的小狗播一遍帮忙删除的动画。
async function trashFiles(filePaths, target, parent){
  const t = target === 2 ? 2 : 1;
  const paths = (filePaths || []).map((p) => {
    if (typeof p !== 'string' || !p) return '';
    if (p.startsWith('file://')) {
      try { return fileURLToPath(p); } catch (_e) { return p; }
    }
    return p;
  }).filter(Boolean);
  if (!paths.length) return;
  // 从 Finder 右键菜单、且桌宠尚未启动时，页面握手会比 argv 晚几拍。
  // 等两只狗的页面就绪后再播动画，避免右键后看不到反应。
  for (let i = 0; i < 80 && (!petReady || !pet2Ready); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // 先让小狗摆出帮忙的动画，再执行系统回收站操作。
  if (t === 2) sendPet2({ type: 'act', act: 'delete' });
  else sendPet({ type: 'act', act: 'delete' });

  let moved = 0;
  const failed = [];
  for (const filePath of paths) {
    try {
      await shell.trashItem(filePath);
      moved++;
    } catch (e) {
      failed.push({ path: filePath, reason: e.message || String(e) });
    }
  }

  if (moved > 0) {
    meetSay(t, moved === 1 ? '坏文件帮你烧掉啦～' : '坏文件都帮你烧掉啦～', 2200);
  } else {
    meetSay(t, '这个坏文件我烧不掉…', 1700);
  }
  if (failed.length) {
    const detail = failed.map((x) => x.path + '\n' + x.reason).join('\n\n');
    try {
      if (parent && !parent.isDestroyed()) {
        await dialog.showMessageBox(parent, {
          type: 'warning', title: '删除文件', buttons: ['知道了'],
          message: `有 ${failed.length} 个文件没能移到回收站`, detail,
        });
      } else {
        await dialog.showMessageBox({
          type: 'warning', title: '删除文件', buttons: ['知道了'],
          message: `有 ${failed.length} 个文件没能移到回收站`, detail,
        });
      }
    } catch (_e) {}
  }
  snapshotToConsole();
}

// 控制台按钮：打开系统文件选择器，再把选中的文件交给小狗处理。
async function deleteFilesFor(target){
  const t = target === 2 ? 2 : 1;
  const parent = (consoleWin && !consoleWin.isDestroyed())
    ? consoleWin
    : (t === 2 ? pet2Win : petWin);
  const opts = {
    title: '选择要删除的文件',
    buttonLabel: '移到回收站',
    properties: ['openFile', 'multiSelections'],
  };
  let picked;
  try {
    picked = (parent && !parent.isDestroyed())
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
  } catch (e) {
    console.warn('[pet] 打开文件选择器失败:', e.message);
    return;
  }
  if (!picked || picked.canceled || !picked.filePaths || !picked.filePaths.length) return;
  await trashFiles(picked.filePaths, t, parent);
}

// Finder「让小狗烧掉」：两只狗同等概率被随机指派
function trashDogTarget(){
  return Math.random() < 0.5 ? 1 : 2;
}

// Finder「让小狗烧掉」/ 其他系统右键菜单通过 --trash-files 把路径传进来。
function deleteFilesFromArgv(argv){
  const i = (argv || []).indexOf('--trash-files');
  if (i < 0) return false;
  const paths = argv.slice(i + 1).filter((p) => p && p[0] !== '-');
  if (!paths.length) return false;
  trashFiles(paths, trashDogTarget());
  return true;
}

// 做饭：要食材；做一次两只都吃饱，而且两只都在的时候才划算
// 这只狗的饱腹度（0~100）：页面汇报的 hunger 是「饥饿」，饱腹度 = 100 - 饥饿
function satietyOf(target){
  const hunger = Number(target === 2 ? pet2State.hunger : petState.hunger) || 0;
  return Math.max(0, Math.min(100, 100 - hunger));
}
function cookNow(target){
  if(foodCount(target) < 1){
    meetSay(target, '没有食材…做不了饭', 1900);
    snapshotToConsole();
    return false;
  }
  // 触发条件（用户要求）：**自己**的饱腹度低于 30 才做饭
  if(satietyOf(target) >= 30){
    meetSay(target, '我还不饿呢…', 1700);
    snapshotToConsole();
    return false;
  }
  setDogSetting(target, 'food', 0); saveSettings();
  if(target === 2) sendPet2({ type: 'act', act: 'cook' });
  else sendPet({ type: 'act', act: 'cook' });
  feedBoth(100);                                  // 双方饱腹度**加满**（饥饿清零）
  meetSay(target, '两只的都做好啦！', 2200);

  // 吃到的那只（没做饭的那只）看到对方做饭，会先馋一下，再说谢谢。
  const eater = (target === 2) ? 1 : 2;
  if(eater === 2) sendPet2({ type: 'act', act: 'crave' });
  else sendPet({ type: 'act', act: 'crave' });
  const THANKS = {
    1: ['谢谢你做饭！', '好吃！谢谢你～', '你做的饭最香啦'],
    2: ['谢谢小金毛～', '好吃！谢谢哦', '谢谢你给我做饭'],
  };
  const lines = THANKS[eater] || ['谢谢！'];
  setTimeout(() => {
    meetSay(eater, lines[(Math.random() * lines.length) | 0], 2200);
  }, 700);

  snapshotToConsole();
  return true;
}

// ---- 自动触发 ----
// 首次 12 秒后就考虑，之后每 25~50 秒考虑一次（原来 25 / 45~90 太保守，
// 用户反馈「加了半天也不自动触发」）。日志里会打一行 `[pet] 自动互动: xxx`。
let nextAutoMeet = Date.now() + 12000;
// 「最近哭过」的时间戳：安慰的触发条件改成「对方在哭」——
// 哭这个动作本身只有 1.6~2.8 秒，而自动检查 5 秒才跑一次，光看当前状态会漏，
// 所以每次状态汇报里看到 cry 就记一下时间，检查时用 20 秒的时间窗。
let pet1CryAt = 0, pet2CryAt = 0;
// 同一场哭只安慰一次：安慰开始后压住一段时间，避免哭哭还没播完、
// 后续几帧状态汇报又把「正在哭」当成新一轮，排队触发第二次。
let comfortCooldownUntil = 0;
// 听到哭就排一次「去哄」——**不走那个 25~50 秒一轮的自动检查**，
// 因为哭只有两秒、而那一轮的间隔太长，「最近哭过」的窗口早就过期了。
// 用户手动点「哭哭」也会走这里。
let comfortTimer = null;
function scheduleComfort(){
  if(comfortTimer) return;
  const until = Date.now() + 9000;
  const tryComfort = () => {
    if(meet){
      if(Date.now() < until) comfortTimer = setTimeout(tryComfort, 500);
      else comfortTimer = null;
      return;
    }
    const now = Date.now();
    const cry1 = (now - pet1CryAt) < 8000;
    const cry2 = (now - pet2CryAt) < 8000;
    if(!cry1 && !cry2){ comfortTimer = null; return; }
    // 只有一只哭 → 另一只去哄；两只都哭 → 哄刚哭的那只
    const comfortPup = (!cry1 && cry2) || (cry1 && cry2 && pet2CryAt >= pet1CryAt);
    if(process.env.PET_DEBUG) console.log('[pet] 听到哭 →', comfortPup ? 'comfortPup' : 'comfortJin');
    if(startMeet(comfortPup ? 'comfortPup' : 'comfortJin')){
      if(comfortPup) pet2CryAt = 0; else pet1CryAt = 0;
      comfortCooldownUntil = Date.now() + 12000;
      comfortTimer = null;
      return;
    }
    // 正赶上双人互动或其他临时忙状态：在「刚哭过」窗口内再试一次。
    if(now < until) comfortTimer = setTimeout(tryComfort, 500);
    else comfortTimer = null;
  };
  comfortTimer = setTimeout(tryComfort, 1000);
}
// 不能动的时候：正在被拖、正在掉、正在互动
const BUSY_STATES = ['drag', 'drop'];
function bothIdle(){
  const a = petState.state, b = pet2State.state;
  return BUSY_STATES.indexOf(a) < 0 && BUSY_STATES.indexOf(b) < 0 && !meet;
}
// 两只狗之间的小对话：低概率、自动触发，只弹气泡，不进入互动动作。
const CHAT_SETS = [
  [{ who: 1, text: '小白，今天风好舒服～' },
   { who: 2, text: '嗯！我也闻到了！' },
   { who: 1, text: '那一起去走走？' },
   { who: 2, text: '好呀，慢慢走～' }],
  [{ who: 2, text: '小金毛，你闻到香味了吗？' },
   { who: 1, text: '闻到了，是不是有零食？' },
   { who: 2, text: '我先帮你看一看…' },
   { who: 1, text: '别把口水滴下来呀。' }],
  [{ who: 1, text: '小白，你藏哪儿啦？' },
   { who: 2, text: '在你后面呀～' },
   { who: 1, text: '吓我一跳！' },
   { who: 2, text: '嘿嘿，抓住你啦！' }],
  [{ who: 2, text: '小金毛，你困不困？' },
   { who: 1, text: '有一点…你也困了吗？' },
   { who: 2, text: '嗯，靠一起睡吧。' },
   { who: 1, text: '晚安，小白。' }],
  [{ who: 1, text: '小白，你今天好乖。' },
   { who: 2, text: '真的吗？我一直很乖！' },
   { who: 1, text: '对，超级乖。' },
   { who: 2, text: '嘿嘿，那我再乖一点～' }],
  [{ who: 2, text: '小金毛，你喜欢下雨吗？' },
   { who: 1, text: '喜欢，雨声很舒服。' },
   { who: 2, text: '那我们躲雨吧。' },
   { who: 1, text: '来吧，我护着你。' }],
  // ---- 线条小狗 IP 经典对话（作者 moonlab_studio 风格）----
  // 打工人共鸣
  [{ who: 2, text: '好想吃饭啊…' },
   { who: 1, text: '我也是。' },
   { who: 2, text: '好想放假…' },
   { who: 1, text: '我也是。' },
   { who: 2, text: '好困，不想上班！' },
   { who: 1, text: '我也是…' },
   { who: 2, text: '想暴富！' },
   { who: 1, text: '我也是！' }],
  // 你为什么不牵我 / 彳亍
  [{ who: 2, text: '你为什么不牵我？' },
   { who: 1, text: '彳亍。' },
   { who: 2, text: '哼！' },
   { who: 1, text: '牵好啦，不撒手。' }],
  // 吵架和好
  [{ who: 2, text: '我再也不想看见你了！' },
   { who: 1, text: '…真的吗' },
   { who: 2, text: '哼，我只是想气你。' },
   { who: 1, text: '男子汉大狗狗不计较，给你买好吃的。' }],
  // 寺里修行（办公寺梗）
  [{ who: 2, text: '我不行了，我要去寺里修行了。' },
   { who: 1, text: '那寺灵吗？' },
   { who: 2, text: '超灵！' },
   { who: 1, text: '…你说的寺是办公寺吧。' }],
  // 咬洗你（保护梗）
  [{ who: 2, text: '好害怕，躲我后面！' },
   { who: 1, text: '怎么了？' },
   { who: 2, text: '敢欺负你我就咬洗他！' },
   { who: 1, text: '…你明明也怕。' }],
  // 成语梗
  [{ who: 1, text: '笑掉小牙。' },
   { who: 2, text: '小材小用。' },
   { who: 1, text: '小哭一场。' },
   { who: 2, text: '小小一只，超级可爱！' }],
  // 想你了
  [{ who: 2, text: '好想小白…' },
   { who: 1, text: '？你不就是小白' },
   { who: 2, text: '哦…好想鸡毛。' },
   { who: 1, text: '我在呢，一直都在。' }],
  // 夸夸
  [{ who: 2, text: '我今天乖不乖？' },
   { who: 1, text: '超级乖。' },
   { who: 2, text: '不愧是我！' },
   { who: 1, text: '嗯，不愧是你。' }],
  // 做饭
  [{ who: 1, text: '我给你做点好吃的。' },
   { who: 2, text: '真的吗！' },
   { who: 1, text: '想吃什么？' },
   { who: 2, text: '只要是你做的都行！' }],
  // 电话
  [{ who: 2, text: '鸡毛，你接电话呀。' },
   { who: 1, text: '在呢在呢。' },
   { who: 2, text: '通话结束，我挂啦！' },
   { who: 1, text: '想你了，别挂呀。' }],
]
let chatBusy = false, chatToken = 0, nextChatAt = Date.now() + 45000;

function chatAvailable(){
  if(meet || !petWin || petWin.isDestroyed() || !pet2Win || pet2Win.isDestroyed()) return false;
  if(dogSetting(1, 'bubble') === false || dogSetting(2, 'bubble') === false) return false;
  if(!settings.auto && !dogSetting(2, 'auto')) return false;
  const quiet = ['drag', 'drop', 'sleep', 'cry'];
  return quiet.indexOf(petState.state) < 0 && quiet.indexOf(pet2State.state) < 0;
}
function startChatSet(){
  if(chatBusy || !chatAvailable()) return;
  const set = CHAT_SETS[(Math.random() * CHAT_SETS.length) | 0];
  const token = ++chatToken;
  chatBusy = true;
  let delay = 0;
  set.forEach((line) => {
    const at = delay;
    setTimeout(() => {
      if(token !== chatToken) return;
      if(!chatAvailable()){
        chatToken++;
        chatBusy = false;
        return;
      }
      meetSay(line.who, line.text, line.ms || 1450);
    }, at);
    delay += line.hold || 1700;
  });
  setTimeout(() => {
    if(token === chatToken) chatBusy = false;
  }, delay + 150);
}
function maybeRandomChat(){
  const now = Date.now();
  if(ball.on) return;                    // 踢球期间别插话，专心玩球
  if(now < nextChatAt) return;
  nextChatAt = now + 90000 + Math.random() * 90000;
  if(chatBusy || Math.random() > 0.18) return;
  if(chatAvailable()) startChatSet();
}
function maybeAutoMeet(){
  const now = Date.now();
  if(ball.on) return;                    // 球还在桌上 → 两只狗都在踢球，不凑一起玩
  if(now < nextAutoMeet) return;
  nextAutoMeet = now + 25000 + Math.random() * 25000;     // 25~50 秒考虑一次
  // 「自动活动」**任一只开着**就允许凑一起（原来要求两只都开，一只关着就永远不触发）
  if(meet || chatBusy) return;
  if(!settings.auto && !dogSetting(2, 'auto')) return;
  if(!bothIdle()) return;
  if(Math.random() > 0.75) return;                        // 75% 会真的凑过去
  const m1 = Number(petState.mood) || 0, m2 = Number(pet2State.mood) || 0;
  const h1 = Number(petState.hunger) || 0, h2 = Number(pet2State.hunger) || 0;
  // ② 做饭：双方都饿 + 有食材
  // 做饭的自动条件（用户要求）：**自己**饱腹度 < 30 且手里有食材。
  // 食材是分开的 → 谁又饿又有食材就谁去做（两个都满足就随机）。
  const can1 = foodCount(1) >= 1 && h1 > 70;
  const can2 = foodCount(2) >= 1 && h2 > 70;
  if(can1 || can2){
    const who = (can1 && can2) ? (Math.random() < 0.5 ? 1 : 2) : (can1 ? 1 : 2);
    if(process.env.PET_DEBUG) console.log('[pet] 自动互动: cook by', who, 'hunger', h1, h2);
    cookNow(who);
    return;
  }
  // ③ 两只都高兴致时，一起跳舞也参加普通互动池；否则只抽聊天/玩/贴贴。
  // 四类互动同权，避免跳舞因为单独 50% 前置概率而明显抢占其他动作。
  const highMood = m1 >= 50 && m2 >= 50;
  const pool = m1 >= m2
    ? (highMood ? ['danceTogether', 'chatJin', 'findJin', 'hugJin']
                : ['chatJin', 'findJin', 'hugJin'])
    : (highMood ? ['danceTogether', 'chatPup', 'findPup', 'hugPup']
                : ['chatPup', 'findPup', 'hugPup']);
  const act = pool[(Math.random() * pool.length) | 0];
  if(process.env.PET_DEBUG) console.log('[pet] 自动互动:', act, 'mood', m1, m2, 'hunger', h1, h2);
  startMeet(act);
}
setInterval(maybeAutoMeet, 5000);
setInterval(maybeRandomChat, 10000);

// ---------------------------------------------------------------------------
// 小白 ← 主进程 / 小白 → 小白
// ---------------------------------------------------------------------------
ipcMain.on('pet2:ready', () => {
  pet2Ready = true;
  // 页面就是小金毛那一份，握手顺序也照抄：先几何、再设置、最后穿透状态。
  // （它的亲密度/饥饿/兴致由页面自己按 localStorage 记，见 index.html 的
  //  PREF_KEY/STATE_KEY —— 小白用的是另一套键，不会和小金毛串。）
  syncPet2Geometry();
  pushPet2Settings();
  setPet2IgnoreMouse(mouseShouldPassThrough(2));
});

// 小白报上来的字段与小金毛一模一样（同一份页面）：state/facing/vx/happiness/
// hunger/mood/strain/why/centerX/centerY/auto/follow/night —— 控制台两边同款画。
ipcMain.on('pet2:report', (_e, snap) => {
  if(!snap) return;
  if (v2) v2.onReport(2, snap);                          // V2：同步影子状态（在删 energy 之前）
  if(snap.state === 'cry' && Date.now() >= comfortCooldownUntil){
    pet2CryAt = Date.now(); scheduleComfort();                           // 小白在哭
  }
  delete snap.energy;
  Object.assign(pet2State, snap, { snapAt: Date.now() });
  // 顺便把亲密度/兴致在设置文件里留一份镜像（控制台/排查用；真源是页面的
  // localStorage）。慢变量，明显变了才写盘，最多 15 秒兜一次底。
  const saved = settings.pet2;
  const changed = Math.abs(Number(saved.intimacy) - Number(pet2State.happiness)) >= 0.5 ||
                  Math.abs(Number(saved.mood) - Number(pet2State.mood)) >= 1;
  if(changed || Date.now() - pet2SaveAt > 15000){
    pet2SaveAt = Date.now();
    saved.intimacy = Math.max(0, Number(pet2State.happiness) || 0);
    saved.mood = clamp(Number(pet2State.mood) || 0, 0, 100);
    saveSettings();
  }
});

// 光标进/出狗身 → 开关鼠标穿透（与第一只同一套判断，见 index.html 的 desktopBridge）
ipcMain.on('pet2:hover', (_e, on) => {
  if(dogClickThrough(2)){                 // 连小狗本身也穿透：不响应 hover
    if(pet2Interactive){ pet2Interactive = false; setPet2IgnoreMouse(true); }
    return;
  }
  if(!dogSetting(2, 'clickThrough')) return;  // 关掉穿透时窗口始终可点
  if(dogSetting(2, 'follow')){                // 追随中保持穿透（见 tickSecond 的说明）
    if(pet2Interactive){ pet2Interactive = false; setPet2IgnoreMouse(true); }
    return;
  }
  if(on === pet2Interactive) return;
  pet2Interactive = !!on;
  setPet2IgnoreMouse(!pet2Interactive);
});

// 拖动：主进程按光标的屏幕坐标搬窗口（页面只负责摆被拎起来的姿态）
let pet2DragTimer = null;
let pet2DragGrab = { dx: 0, dy: 0 };

ipcMain.on('pet2:drag-start', () => {
  if(dogClickThrough(2)){ setPet2IgnoreMouse(true); return; }
  pet2Suspended = true;
  pet2Falling = false;
  pet2FallVy = 0;
  pet2Interactive = true;
  if(dogSetting(2, 'clickThrough')) setPet2IgnoreMouse(false);
});

ipcMain.on('pet2:drag-begin', () => {
  if(!pet2Win || pet2Win.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const b = pet2Win.getBounds();
  // 抓哪儿就按哪儿拖（光标在狗身上按下时的相对位置）
  pet2DragGrab = { dx: c.x - b.x, dy: c.y - b.y };
  pet2Dragged = true;
  pet2TargetY = null;
  if(pet2DragTimer) clearInterval(pet2DragTimer);
  pet2DragTimer = setInterval(() => {
    if(!pet2Win || pet2Win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const g = pet2Geometry();
    const r = pet2Range(g), vr = pet2VerticalRange(g);
    pet2X = clamp(p.x - pet2DragGrab.dx, r.min, r.max);
    pet2Y = clamp(p.y - pet2DragGrab.dy, vr.minWindowY, vr.maxWindowY);
    pet2Win.setBounds({ x: Math.round(pet2X), y: Math.round(applyDogShift(2, pet2Y)),
                        width: g.winW, height: g.winH });
  }, 16);
});

ipcMain.on('pet2:drag-stop', () => {
  if(pet2DragTimer){ clearInterval(pet2DragTimer); pet2DragTimer = null; }
  pet2Dragged = false;
  pet2Suspended = roamSuspendFrom();
  settings.pet2.x = Math.round(pet2X);
  settings.pet2.y = Math.round(pet2Y);
  saveSettings();
  // 松手：开着坠落模式而且还在半空 → 真的掉回地面线；否则原地站好。
  // （与第一只的 releaseDrag() 同一个规矩，只是它那边还有一身物理量要处理。）
  const g = pet2Geometry();
  const vr = pet2VerticalRange(g);
  if(!pet2Win || pet2Win.isDestroyed()) return;
  if(dogSetting(2, 'fall') && pet2Y < fallGroundY(2) - 4){
    pet2Falling = true; pet2FallVy = 0;
    sendPet2({ type: 'fall' });          // 与小金毛同名：页面切掉落姿态
  }else{
    if(dogSetting(2, 'fall') && pet2Y !== fallGroundY(2)){
      pet2Y = fallGroundY(2);
      pet2Win.setBounds({ x: Math.round(pet2X), y: Math.round(pet2Y),
                          width: g.winW, height: g.winH });
    }
    sendPet2({ type: 'stand' });         // 与小金毛同名：页面站好
  }
});

ipcMain.on('pet2:drag-end', () => {
  pet2Interactive = false;
  if(mouseShouldPassThrough(2)) setPet2IgnoreMouse(true);
  settings.pet2.x = Math.round(pet2X);
  settings.pet2.y = Math.round(pet2Y);
  saveSettings();
});

// 页面里自己点的动作（摸头 / 双击）：立刻把两条状态推到控制台，
// 别等控制台那一秒一次的轮询 —— 摸完马上能看到亲密度跳了一格。
ipcMain.on('pet2:action', () => { if (v2) v2.recordInteract(2); snapshotToConsole(); });
ipcMain.on('pet:easter-egg', () => showEasterEgg(1));
ipcMain.on('pet2:easter-egg', () => showEasterEgg(2));
ipcMain.on('pet2:open-console', () => openConsole2());

// 把控制台窗显到**用户真能看见**的地方。
// 为什么不能只调 win.show()：这个应用平时没有焦点（狗是浮在最上面的独立窗口，
// 用户很可能正在浏览器里干活）。macOS 会把新窗口排到「当前前台应用」的后面，
// 于是 win.show() 明明成功了，用户看到的却是「点了没反应」。
// app.focus({ steal: true }) 是 darwin 专有的「抢焦点」——不加 steal，系统会
// 礼貌地忽略这个激活请求。moveTop() 再兜一层同应用内的窗口顺序。
function revealConsole(win) {
  win = win || consoleWin;
  if (!win || win.isDestroyed()) return;
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.show();
  win.focus();
  win.moveTop();
}

// 打开控制台 —— **所有入口都走这里**：托盘单击 / 右键菜单、小狗右键、
// Dock 图标（activate）、再次双击 .app（second-instance）、启动时恢复。
// 两只狗共用同一扇控制台窗，用页面里的标签切换当前操作对象。
function openConsole() { openConsoleFor(settings.consoleTarget || 1); }
function openConsole2() { settings.consoleTarget = 2; saveSettings(); openConsoleFor(2); }
function openConsoleFor(target) {
  const t = target === 2 ? 2 : 1;
  const win = consoleWin;
  if (!win || win.isDestroyed()) createConsoleWindow(t);
  else {
    win.webContents.send('console:select-pet', t);
    revealConsole(win);
  }
}

// 两只狗共用**同一张页面**（app/console.html）和同一扇窗口：
// 页面里的「小金毛 / 小白」标签负责切换当前那一只；控制台动作和设置都按标签目标走。
// 显示 / 隐藏某一只狗。**只隐藏窗口**（页面继续在后台跑，控制台也还在），
// 这样从它自己的控制台或托盘菜单随时能再打开。
// 互动演到一半被打断（比如这时把某一关掉了）：停定时器、收片段、恢复窗口
function meetAbort(){
  if(!meet) return;
  if(meetTimer){ clearInterval(meetTimer); meetTimer = null; }
  clearMeetChatTimers(meet);
  sendPet({ type: 'driven', state: null });
  sendPet2({ type: 'driven', state: null });
  sendPet2({ type: 'meetEnd' });
  if(petWin && !petWin.isDestroyed()) showPetWindow(petWin);
  roamSuspended = false;
  pet2Suspended = false;
  meet = null;
  snapshotToConsole();
}


function createConsoleWindow(target) {
  target = target === 2 ? 2 : 1;
  const existing = consoleWin;
  if (existing && !existing.isDestroyed()) { revealConsole(existing); return; }
  // 闭包里用这个局部常量，别回头读模块级的 consoleWin：窗口重建后容易指错对象。
  const win = new BrowserWindow({
    width: 430,
    height: 820,
    minWidth: 380,
    minHeight: 480,
    title: (target === 2 ? '小白' : '小金毛') + ' · 宠物控制台',
    // hiddenInset 是 macOS 专有（把标题栏做进内容里）。Windows 上它会被忽略、
    // 退回系统标题栏 —— 显式按平台给，免得平台间行为不一致时难排查。
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    // Windows 的窗口图标取自这里（macOS 走 .app 包里的 icon.icns）。
    // 打包时 exe 自身的图标由 electron-builder 用 build/icon.ico 烧进去，
    // 这里是给窗口用的（任务栏 / Alt-Tab）。
    ...(process.platform === 'win32'
        ? { icon: path.join(ASSET_DIR, 'icon.png') } : {}),
    show: false,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload-console.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  consoleWin = win;

  // 页面加载失败必须留下痕迹。窗口是 show:false 建的，只在 ready-to-show 里
  // 显示；加载失败时那个事件永远不来，窗口就永久隐身 —— 而日志里一个字都没有，
  // 排查时只能靠猜。
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.warn('[pet] 控制台页面加载失败：%s %s %s', code, desc, url);
  });

  if (target === 2) win.loadFile(CONSOLE_PAGE, { search: 'pet=2' });
  else win.loadFile(CONSOLE_PAGE);
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    revealConsole(win);
    fitConsoleHeight(win);
    settings.consoleOpen = true;
    settings.console2Open = target === 2;
    saveSettings();
    pushSettings();
  });
  // 兜底：ready-to-show 万一不来（加载失败、或被缓存抢在监听之前跑完），
  // 也把它显出来。宁可让用户看到一个白窗，也不要「点了完全没反应」。
  setTimeout(() => {
    if (win.isDestroyed() || win.isVisible()) return;
    console.warn('[pet] 控制台 ready-to-show 未触发，兜底显示');
    revealConsole(win);
    fitConsoleHeight(win);
  }, 1500);

  win.on('closed', () => {
    // 只清理「自己还是当前那一个」的情况：万一关掉的是旧窗口、而新窗口已经开好了，
    // 不能把新窗口的引用一起抹掉。
    if (consoleWin !== win) return;
    consoleWin = null;
    settings.consoleOpen = false;
    settings.console2Open = false;
    saveSettings();
  });
}

// ---------------------------------------------------------------------------
// 控制台窗口高度：按内容量一次，别写死
//   控制台的内容是会长高的（动作按钮 + 三组开关 + 说明文字），写死高度总会有
//   一天对不上 —— 实际就出现过「窗口」那组开关被截在折线以下、「点击穿透」整个
//   看不见，要滚动才发现。所以让页面自己量一遍再回话。
// ---------------------------------------------------------------------------
async function fitConsoleHeight(win) {
  win = win || consoleWin;
  if (!win || win.isDestroyed()) return;
  let need;
  try {
    need = await win.webContents.executeJavaScript(
      '(() => {'
      + ' const q = (s) => document.querySelector(s);'
      + ' const h = q("header"), n = q(".now"), m = q("main"), f = q("footer");'
      + ' return Math.ceil(h.offsetHeight + (n ? n.offsetHeight : 0)'
      + '   + m.scrollHeight + f.offsetHeight);'
      + '})()');
  } catch (e) {
    return;                       // 量不到就用建窗时的默认高度，不影响功能
  }
  if (!Number.isFinite(need)) return;

  const wa = workArea();
  const target = Math.round(clamp(need, 480, wa.height - 40));
  const b = win.getBounds();
  if (Math.abs(b.height - target) <= 2) return;
  // 长高之后底边别钻到 Dock 底下：必要时往上挪。
  const y = Math.min(Math.max(b.y, wa.y), Math.max(wa.y, wa.y + wa.height - target));
  win.setBounds({ x: b.x, y: y, width: b.width, height: target });
}

// ---------------------------------------------------------------------------
// 穿透 / 置顶
// ---------------------------------------------------------------------------
function setIgnoreMouse(on) {
  if (!petWin || petWin.isDestroyed()) return;
  petWin.setIgnoreMouseEvents(!!on, { forward: true });
}

// 宠物窗口只负责被看见，不应该抢系统焦点。互动结束、恢复窗口时用
// showInactive()，避免 Chrome 等前台应用因为 Electron 重新激活而失焦 / 最小化。
function showPetWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (typeof win.showInactive === 'function') win.showInactive();
  else win.show();
}

function dogClickThrough(target){ return !!dogSetting(target, 'clickThroughDog'); }
function mouseShouldPassThrough(target){
  return !!dogSetting(target, 'clickThrough') || dogClickThrough(target);
}

function applyAutoStart() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const enabled = !!settings.autoStart;
  const opts = { openAtLogin: enabled };
  if (process.platform === 'win32') {
    opts.path = process.execPath;
    // 开发环境下 Electron 需要应用目录作为参数；正式 EXE 不需要。
    opts.args = app.isPackaged ? [] : [APP_DIR];
  }
  try {
    app.setLoginItemSettings(opts);
  } catch (e) {
    console.warn('[pet] 更新开机自启动设置失败:', e.message);
  }
}

// macOS Finder「快速操作」：安装一个轻量 Automator workflow。
// 选中文件后右键 → 快速操作/服务 →「让小狗烧掉」，会把路径通过
// --trash-files 参数交给桌宠，实际仍然走系统回收站。
function xmlEscape(value){
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function shellQuote(value){
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
function installFinderService(){
  if(process.platform !== 'darwin') return null;
  const serviceDir = path.join(app.getPath('home'), 'Library', 'Services', '让小狗烧掉.workflow');
  const contents = path.join(serviceDir, 'Contents');
  const resources = path.join(contents, 'Resources');
  fs.rmSync(serviceDir, { recursive: true, force: true });
  fs.mkdirSync(resources, { recursive: true });

  const appExe = shellQuote(process.execPath);
  const script = [
    '#!/bin/bash',
    'APP=' + appExe,
    'if [ "$#" -gt 0 ]; then',
    '  "$APP" --trash-files "$@"',
    'else',
    '  /usr/bin/osascript -e \'display alert "小金毛桌宠" message "没有拿到文件名，请重新选择文件。"\'',
    'fi',
  ].join('\n') + '\n';

  const workflow = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>AMApplicationBuild</key><string>346</string>
<key>AMApplicationVersion</key><string>2.3</string>
<key>AMDocumentVersion</key><string>2</string>
<key>actions</key><array><dict><key>action</key><dict>
<key>AMAccepts</key><dict><key>Container</key><string>List</string><key>Optional</key><true/><key>Types</key><array><string>com.apple.cocoa.path</string></array></dict>
<key>AMActionVersion</key><string>2.0.3</string>
<key>AMApplication</key><array><string>Automator</string></array>
<key>AMParameterProperties</key><dict><key>COMMAND_STRING</key><dict/><key>CheckedForUserDefaultShell</key><dict/><key>inputMethod</key><dict/><key>shell</key><dict/><key>source</key><dict/></dict>
<key>AMProvides</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
<key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
<key>ActionName</key><string>Run Shell Script</string>
<key>ActionParameters</key><dict>
  <key>COMMAND_STRING</key><string>${xmlEscape(script)}</string>
  <key>CheckedForUserDefaultShell</key><true/>
  <key>inputMethod</key><integer>1</integer>
  <key>shell</key><string>/bin/bash</string>
  <key>source</key><string></string>
</dict>
<key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
<key>CFBundleVersion</key><string>2.0.3</string>
<key>CanShowSelectedItemsWhenRun</key><false/>
<key>CanShowWhenRun</key><true/>
<key>Category</key><array><string>AMCategoryUtilities</string></array>
<key>Class Name</key><string>RunShellScriptAction</string>
<key>InputUUID</key><string>5D5421E2-9C37-4B15-9DDD-1C052E11E5E8</string>
<key>OutputUUID</key><string>69F95E56-8143-4C86-977E-476361EF2BB1</string>
<key>UUID</key><string>7F03EBDB-188C-4E65-B515-FDC60D553649</string>
<key>UnlocalizedApplications</key><array><string>Automator</string></array>
<key>arguments</key><dict><key>0</key><dict><key>default value</key><integer>1</integer><key>name</key><string>inputMethod</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>0</string></dict><key>1</key><dict><key>default value</key><string></string><key>name</key><string>source</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>1</string></dict><key>2</key><dict><key>default value</key><true/><key>name</key><string>CheckedForUserDefaultShell</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>2</string></dict><key>3</key><dict><key>default value</key><string></string><key>name</key><string>COMMAND_STRING</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>3</string></dict><key>4</key><dict><key>default value</key><string>/bin/bash</string><key>name</key><string>shell</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>4</string></dict></dict>
<key>isViewVisible</key><true/><key>location</key><string>309.5:631</string><key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/en.lproj/main.nib</string>
</dict></dict></array>
<key>connectors</key><dict/>
<key>workflowMetaData</key><dict>
<key>serviceApplicationBundleID</key><string>com.apple.finder</string>
<key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
<key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
<key>serviceProcessesInput</key><integer>1</integer>
<key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
</dict>
</dict></plist>`;
  const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
<key>CFBundleIdentifier</key><string>com.workbuddy.golden-puppy-pet.trash-service</string>
<key>CFBundleName</key><string>让小狗烧掉</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>NSServices</key><array><dict>
<key>NSMenuItem</key><dict><key>default</key><string>让小狗烧掉</string></dict>
<key>NSMessage</key><string>runWorkflowAsService</string>
<key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
<key>NSSendTypes</key><array><string>public.file-url</string><string>NSFilenamesPboardType</string></array>
<key>NSSendFileTypes</key><array><string>public.item</string></array>
</dict></array>
</dict></plist>`;
  fs.writeFileSync(path.join(resources, 'document.wflow'), workflow, 'utf8');
  fs.writeFileSync(path.join(contents, 'Info.plist'), info, 'utf8');
  // Flush the Services database; failure here is harmless and Finder refreshes later.
  try {
    execFile('/System/Library/CoreServices/pbs', ['-flush'], () => {});
  } catch (_e) {}
  return serviceDir;
}

function applyAlwaysOnTop() {
  // 「总是置顶」也是每只一份：控制台里改哪只就只动哪只的窗口
  const wins = [[petWin, 1], [pet2Win, 2]];
  for (const [w, target] of wins) {
    if (!w || w.isDestroyed()) continue;
    // 'floating' 这个层级只有 macOS 认；Windows 上会忽略第二个参数。
    w.setAlwaysOnTop(!!dogSetting(target, 'alwaysOnTop'),
                     process.platform === 'darwin' ? 'floating' : 'normal');
    if (process.platform !== 'win32') {
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
  }
}

// 连续摸头十次的小彩蛋：透明全屏层只负责播一只放大的爪子/脸，
// 不抢焦点、不拦截鼠标，播完自动关闭。
function showEasterEgg(target){
  const t = target === 2 ? 2 : 1;
  const owner = t === 2 ? pet2Win : petWin;
  let display;
  try {
    display = (owner && !owner.isDestroyed())
      ? screen.getDisplayMatching(owner.getBounds())
      : screen.getPrimaryDisplay();
  } catch (_e) {
    display = screen.getPrimaryDisplay();
  }
  const b = display.bounds;
  if(easterEggWin && !easterEggWin.isDestroyed()) easterEggWin.destroy();
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: true, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, focusable: false, show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  easterEggWin = win;
  win.setIgnoreMouseEvents(true, { forward: true });
  if(process.platform !== 'win32'){
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  try {
    win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'normal');
  } catch (_e) {
    win.setAlwaysOnTop(true);
  }
  win.loadURL(pathToFileURL(EASTER_PAGE).href + '?pet=' + t);
  win.once('ready-to-show', () => showPetWindow(win));
  win.on('closed', () => { if(easterEggWin === win) easterEggWin = null; });
  setTimeout(() => { if(!win.isDestroyed()) win.close(); }, 3000);   // 彩蛋播 3 秒
}

// ---------------------------------------------------------------------------
// 桌面小球（踢球小游戏）
// ---------------------------------------------------------------------------
// **在桌面上玩，不另开界面**：球就是桌面上的一扇小窗（只有一颗球那么大、
// 平时整体鼠标穿透，光标压到球上才允许点）。**没有重力**：扔出去和踢出去都是
// 一条直线，撞到「所有屏幕工作区的并集」的外沿才回弹，慢慢减速。两只狗还是
// 它们自己那两扇窗，跑过去把球「叼走」——
// 球先消失，狗踢一脚把球踢飞，**踢完再原地做个积极动作**，然后接着去追。
//
// 为什么物理放在主进程：窗口坐标本来就在这儿（漫游引擎、互动全都按屏幕坐标算），
// 球只是个点，放这边算最省事。页面那边只负责把球画出来 + 报告按下/松开。
//
// 「狗踢球那一脚」用的是素材里画好的那 6 帧（app/assets/pet2/kick、kickJin），
// **素材里的球故意留着**：狗叼走球的时候桌面上那颗已经藏起来了，正好由素材里
// 这颗顶上，踢完那一帧再把物理球放回同一个位置飞出去 —— 位置由下面的
// BALL_KICK_OFF 对齐（两只狗各一套，换素材要回来重标）。
let ballWin = null;
let ballTimer = null;
let ballLastTick = 0;
const ball = {
  on: false,          // 桌面上有没有球
  x: 0, y: 0,         // 球心（屏幕坐标）
  vx: 0, vy: 0,
  r: 38,
  grabbed: false,     // 鼠标正拿着
  held: false,        // 被小狗叼走了：这期间不画、也不给点
  grabDX: 0, grabDY: 0,
  samples: [],        // 拖动轨迹，用来算甩出去的速度
  interactive: false, // 当前这扇球窗是不是「可点」（其余时候整窗穿透）
  lastTop: 0,
  noCatchUntil: 0,    // 这个时刻之前谁都不许「接住」球（刚踢出去的那一下）
  blockCd: { 1: 0, 2: 0 },   // 狗身挡球的冷却（免得同一个球在身上反复弹）
  grabAt: 0,          // 这一轮「球被拿在手里」是从什么时候开始的
};
const ballDogs = { 1: null, 2: null };   // 每只狗在这局里的临时状态
// 认真赛进球之后的那段「仪式」：胜者积极 / 败者消极 → 各回固定位置 → 重新开球。
// null = 正常踢球中。
let ballKickoff = null;
// 左右两个球门：各一扇小窗（画门框+网+比分）。归属是「左边那只 / 右边那只」，
// 只有一只狗在的时候两个门都算它的。球进门 → 门的主人加分并高兴一下。
const goalWins = { left: null, right: null };
let ballScore = { 1: 0, 2: 0 };
// 球门归属（**按足球常识**）：
//   每只狗守自己那一侧的门 —— 小金毛守左、小白守右，那就是它的「自家球门」；
//   把球踢进**对面的门**才算自己得分。所以：
//     · 计分按狗记：ballScore[1] / ballScore[2]
//     · 左边的门被攻破 → 小白得分；右边的门被攻破 → 小金毛得分
//     · 开局/开球的固定站位也是各站自己那一侧（和小金毛守左、小白守右一致）
function ballSideDog(side){ return side === 'right' ? 2 : 1; }   // 这扇门是谁守的
function ballDogSide(dog){ return dog === 2 ? 'right' : 'left'; } // 这只狗守哪一侧
function ballAttackSide(dog){ return ballDogSide(dog) === 'left' ? 'right' : 'left'; }
// 这扇门破了该给谁加分 = 守门那只的对手（只有一只狗开着时就自攻自守）
// 两只狗始终同屏：进球给守门那只的对手
function ballScorerOf(side){
  const own = ballSideDog(side);
  return own === 1 ? 2 : 1;
}

const BALL_PAD = 6;              // 球窗比球大出来的边（留给高光和抗锯齿）
// **不做重力**（用户要求）：球走直线。那它靠什么停下来？靠这点空气阻力 ——
// 每秒衰减到 66%，再配合撞边 0.8 的回弹系数，踢出去大概三四秒就慢到狗追得上。
// 每秒速度保留比例。**调小了**（0.5 → 0.38）：用户要的是「刚踢出去唰地一下
// 飞出去、然后慢慢降下来、等它慢下来狗才追得上」。留得越少衰减越快、球跑不远；
// 留得越多球飞得越久、狗追得越辛苦，0.38 实测踢出去约 3 秒多狗才追上。
const BALL_DAMP = 0.38;
const BALL_BOUNCE = 0.80;        // 撞到屏幕外沿的速度保留比例
const BALL_STOP = 50;            // 慢到这个速度（scale=1）就干脆停住
// 比这个慢才允许狗「接住」；比这快就只追。**必须明显低于狗的追球速度**
//（追球速度 = FOLLOW_SPEED 460 × 0.85 ≈ 390），不然狗永远追不上、球一直吊着。
// 狗的追球速度约 390，这里压在它下面 —— 球还快的时候狗**够不着**，
// 只有球慢下来它才追得上（用户要的正是这个节奏）。
const BALL_CATCH_SPEED = 300;
const BALL_MAX_THROW = 2600;     // 甩出去的速度上限（scale=1）
const BALL_R_DISP = 34;          // scale=1 时球的半径（显示像素）——取两头素材的折中：
                                 // 矢量姿态那颗 ≈29、位图片段那颗 ≈38，都被它顶替过
// 踢球那一帧里「画上去的那颗球」相对**狗身中心 / 脚底线**的偏移（显示像素，scale=1）。
// 两只狗的素材是两套画法、球的落点也不一样，所以分开给：
//   小金毛 = gifpose 矢量姿态 kick  —— 由 kick.json 的 place(k, tx, ty) 换算
//   小白   = 位图片段 kick           —— 直接量 app/assets/pet2/kick/00.webp
// 换素材要回来重标这两个数。
const BALL_KICK_OFF = {
  1: { dx: 35.3, dy: 32.8 },
  2: { dx: 51.7, dy: 43.3 },
};
// 踢出去的方向：七成瞄准对面球门，剩下三成乱踢也**只能朝对方半场**。
// 这样球不会从小狗脚下直接飞向自家门，避免乌龙球。
const BALL_AIM_CHANCE = 0.7;

// 接球那一刻定下这一脚往哪儿踢：
//   瞄准档 → 记住对面的门 + 门里随机高度；
//   乱踢档 → 前后角度最多偏 60°，但水平方向始终朝对面半场。
function ballPickKick(target){
  const aimSide = ballAttackSide(target);
  const forward = aimSide === 'left' ? -1 : 1;
  if(Math.random() < BALL_AIM_CHANCE){
    const g = ballGoalRect(aimSide);
    const b = ballBounds();
    return { side: aimSide,
             ty: g.y + g.h * (0.28 + Math.random() * 0.44),
             dir: (aimSide === 'left' ? b.x : b.x + b.width) >= ball.x ? 1 : -1 };
  }
  return { side: null,
           ang: (Math.random() * 2 - 1) * (Math.PI / 3),
           flip: forward,
           spd: 1400 + Math.random() * 600 };
}

function ballKickOffset(target){
  const o = BALL_KICK_OFF[target] || BALL_KICK_OFF[1];
  const sc = ballScale();
  return { dx: o.dx * sc, dy: o.dy * sc };
}
// **踢完之后**原地做的积极动作 —— 用户要求「随机做各种积极动作，不要只会庆祝」。
// ms 是该动作播一轮的时长（矢量姿态按 FRAMES 的 n×ms，位图片段按 clips.json 的
// durs 之和取的折中值；两只狗同一套，宁可多停一点也不要演半截）。
const BALL_CHEERS = [
  { state: 'celebrate', ms: 1400 },
  { state: 'laugh',     ms: 1400 },
  { state: 'jump',      ms: 1300 },
  { state: 'spin',      ms: 1400 },
  { state: 'dance',     ms: 1500 },
  { state: 'excited',   ms: 1400 },
  { state: 'hehe',      ms: 1300 },
];
// 认真赛进球之后**输的那只**做的消极动作（用户要求：胜者积极、败者消极）
const BALL_SADS = [
  { state: 'bored',   ms: 1300 },
  { state: 'wronged', ms: 1400 },
  { state: 'poor',    ms: 1400 },
  { state: 'wrong',   ms: 1300 },
  { state: 'cry',     ms: 1400 },
];
const BALL_CHEER_MS = 1400;      // 兜底时长（挑不到时用）
// 你**把球拿在手里**的时候，小狗凑到手边会随机做一个「求扔球」的小动作。
// 这一档刻意挑「原地能做完、不含道具」的：坐 / 转圈 / 跳 / 兴奋 / 嘿嘿 / 庆祝。
const BALL_ASKS = [
  { state: 'sit',       ms: 1200 },
  { state: 'spin',      ms: 1400 },
  { state: 'jump',      ms: 1300 },
  { state: 'excited',   ms: 1400 },
  { state: 'hehe',      ms: 1300 },
  { state: 'celebrate', ms: 1400 },
];
const BALL_KICK_MS = 600;        // 踢球片段本身的时长（小金毛矢量 6 拍×100ms，小白位图 530ms）
// 追球速度倍率。跑起来的样子是「小跑跟过去」，不是冲刺 —— 一开始给到 1.25
//（575 px/s）用户反馈太快，压到 0.85（约 390 px/s）。它必须**高于**
// BALL_CATCH_SPEED，狗才追得上滚动的球。
const BALL_CHASE_BOOST = 0.85;
// 踢球小游戏里**每只狗自己的追球速度倍率**（只影响踢球，不影响平时漫游）。
// 用户反复实测：小白几乎总是先够到球、一直赢。两边代码路径是对称的，与其继续
// 找那点差异，直接给金毛一点速度补偿把胜率拉平 —— 这一个数就是平衡旋钮：
// 想让它更强势就往上加，想还原就都写 1。
const BALL_DOG_SPEED_MUL = { 1: 1.00, 2: 1.00 };
// 刚踢出去的这一小段时间里**谁都不许接球**。少了它会出这个毛病：球离开脚
// 才一帧，速度还很小、位置还在身边，旁边那只立刻判定「可以接」，于是球被踢
// 出去又马上被叼回来 —— 看起来就是「还没踢出去又接到了」。800ms 之后球已经
// 飞出四百多像素，狗再也够不着。
const BALL_NOCATCH_MS = 800;

function ballScale(){
  return clamp(Number(settings.scale) || 1, SCALE_MIN, maxScale(1));
}
// 球的边界 = **所有显示器工作区的并集**（用户要求：全部屏幕都能踢）。
// 各屏分辨率/纵向偏移不一样，并集是一个矩形，可能含一点「没屏的空档」——
// 对这个玩具足够，球不会飞出真正的桌面范围。
// 踢球用的边界 = 和平时漫游同一份「整张桌面」
function ballBounds(){ return desktopWorkBounds(); }
// 踢球期间专用的「把狗摆到屏幕坐标」：夹取范围用上面那个并集，而不是狗当前
// 所在的那一块屏 —— 球能飞到别的屏幕上去，狗就得能追过去。
// （平时的漫游仍然只在自己那块屏里，不改。）
function ballPlaceDogCenter(target, cx, cy){
  const g = target === 2 ? pet2Geometry() : geometry();
  const win = target === 2 ? pet2Win : petWin;
  if(!win || win.isDestroyed()) return;
  const b = ballBounds();
  const padX = target === 2 ? g.padX : PAD_X;
  const foot = target === 2 ? PET2_FOOT : FOOT;
  const x = clamp(Math.round(cx - (padX + g.boxW / 2)),
                  Math.round(b.x - padX), Math.round(b.x + b.width - padX - g.boxW));
  // 竖直方向夹的必须是**狗身**，不是窗口。窗口上方那一截（head = 起跳弧线 +
  // 气泡的高度，小金毛 scale=1 时足足 420px）只是留白：夹窗口的话狗身就只能
  // 走到屏幕上方 420px 处，看起来就是「跑到上界面一定距离就停住上不去了」。
  // 所以允许窗口顶伸到工作区上方 head 那么多（那一段是透明的，狗身正好顶到屏幕边）。
  const want = clamp(Math.round(cy - (g.winH - foot - g.boxH / 2)),
                     Math.round(ballVertBounds().y - (g.winH - foot - g.boxH)),
                     Math.round(b.y + b.height - g.boxH - (g.winH - foot - g.boxH)));
  const y = applyDogShift(target, want);      // 窗口顶到上限之后改挪狗
  if(target === 2){ pet2X = x; pet2Y = y; } else { roamX = x; roamY = y; }
  win.setBounds({ x: x, y: y, width: g.winW, height: g.winH });
}
// 二维追球（没有重力之后球可能停在半空，狗得斜着跑过去）
function ballMoveDogToward(target, tx, ty, dt, extraMul){
  const cur = meetDogCenter(target);
  const dx = tx - cur.x, dy = ty - cur.y;
  const dist = Math.hypot(dx, dy);
  if(dist < 0.5) return;
  const speed = FOLLOW_SPEED * Number(dogSetting(target, 'speedMul')) * BALL_CHASE_BOOST
                * (BALL_DOG_SPEED_MUL[target] || 1) * (extraMul || 1);
  const step = Math.min(dist, speed * Math.max(0, dt));
  ballPlaceDogCenter(target, cur.x + dx / dist * step, cur.y + dy / dist * step);
}
function ballRadius(){ return Math.max(9, Math.round(BALL_R_DISP * ballScale())); }
function ballGroundY(){ return verticalRange(geometry()).bottomY; }

// 球门：贴着「所有屏幕工作区并集」的最左/最右沿，竖直方向居中。
// 高度给到并集的 52% —— 球是没有重力的、会满屏乱飞，门太矮就几乎进不了。
const BALL_GOAL_W = 108;
// 竖直方向用**显示器的完整边界**（不是工作区）：工作区顶边在菜单栏下面，
// 拿它当上限的话，狗头顶永远差菜单栏那几十像素够不到屏幕最顶上。
// 水平仍然用工作区 —— 别让球和狗钻到 Dock 底下。
function ballVertBounds(){
  let y0 = Infinity, y1 = -Infinity, any = false;
  try {
    screen.getAllDisplays().forEach((d) => {
      y0 = Math.min(y0, d.bounds.y);
      y1 = Math.max(y1, d.bounds.y + d.bounds.height);
      any = true;
    });
  } catch (_e) { any = false; }
  if(!any){ const a = workArea(); y0 = a.y; y1 = a.y + a.height; }
  return { y: y0, height: y1 - y0 };
}

// 球能待的高度范围。**这不是随便夹的**：踢球那一帧里，画上去的那颗球是在
// 狗脚底上方 off.dy 的地方，而狗的脚最低只能到工作区底边、最高只能到「头顶顶住
// 屏幕上沿」。反推回去 —— 球心不能比 b.y + (boxH - off.dy) 更高，否则狗够得着球
// 却站不到踢球位，踢出去时球会被摆到它脚边，看着就是「瞬移」。
// 两只狗的 off.dy 不一样，取更严的那个。
function ballVerticalRange(){
  const b = ballBounds();
  const vb = ballVertBounds();
  let need = 0;
  [1, 2].forEach((t) => {
    const win = t === 2 ? pet2Win : petWin;
    if(!win || win.isDestroyed()) return;
    const g = t === 2 ? pet2Geometry() : geometry();
    need = Math.max(need, g.boxH - ballKickOffset(t).dy);
  });
  if(!need) need = geometry().boxH - ballKickOffset(1).dy;
  // 顶边给到「显示器最上沿」（狗头顶能贴到屏幕最顶上），底边仍按工作区（避开 Dock）
  return { min: Math.round(vb.y + need), max: Math.round(b.y + b.height - ball.r) };
}

function ballGoalRect(side){
  const b = ballBounds();
  const h = Math.round(Math.max(140, Math.min(b.height - 16, b.height * 0.52)));
  const y = Math.round(b.y + (b.height - h) / 2);
  const w = Math.round(Math.min(BALL_GOAL_W, Math.max(64, b.width * 0.12)));
  const x = side === 'left' ? b.x : b.x + b.width - w;
  return { x: x, y: y, w: w, h: h };
}
function ballGoalName(side){
  const own = ballSideDog(side);
  return own === 2 ? '小白' : '小金毛';
}
function sendToDog(target, msg){
  if(target === 2) sendPet2(msg); else sendPet(msg);
}

// ---------------------------------------------------------------------------
// 「窗口顶到上限之后，把狗在窗口里继续往上挪」
// ---------------------------------------------------------------------------
// macOS 会把**可见窗口**的顶边夹在工作区顶边以内（菜单栏下面那道线），窗口本身
// 出不了屏幕（隐藏窗口不受这个限制，所以拿隐藏窗口测会得出错误结论）。
// 而狗是画在窗口**底部**的，窗口上方那 300~360 像素是留给起跳和气泡的留白 ——
// 于是光靠搬窗口，狗身最多只能走到「屏幕顶 + 那一截留白」的高度，再往上一动不动。
//
// 对策：窗口顶到上限之后不再硬顶，而是把**狗在窗口内部往上挪**同样的距离
//（页面上就是 pet.y -= shift）。这样窗口还在允许的位置，狗身却能继续往上，
// 直到狗头顶抵住窗口顶（那已经是窗口能显示的最高处）。
const dogShift = { 1: 0, 2: 0 };

// 期望的窗口 y → 实际能放的窗口 y（并把需要的移位量发给页面）。返回要用的窗口 y。
function applyDogShift(target, desiredWinY){
  const t = target === 2 ? 2 : 1;
  const g = t === 2 ? pet2Geometry() : geometry();
  const foot = t === 2 ? PET2_FOOT : FOOT;
  const limit = workArea().y;                                   // macOS 的夹取线
  // 狗最多挪到窗口顶，但**留 3px 余量**：真顶到窗口边缘时，矢量骨架那点溢出
  // 和描边会被窗口裁掉，看起来像在闪。挪到差 3px 就够了（视觉效果没差别）。
  const maxShift = Math.max(0, Math.round(g.winH - foot - g.boxH) - 3);
  const want = Math.round(desiredWinY);
  const winY = Math.max(want, limit);                           // 窗口顶就停在这条线上
  const shift = Math.round(clamp(winY - want, 0, maxShift));    // 差多少就让狗在窗口里挪多少
  if(dogShift[t] !== shift){
    dogShift[t] = shift;
    sendToDog(t, { type: 'shift', px: shift });
  }
  return winY;
}

// 踢球小游戏专用台词：四个场合各一组，随机挑一句。
//   chase 跑着追球 / kick 踢出去那一下 / cheer 踢完做积极动作 / held 球被玩家拿在手里
// **同场合有冷却**：狗一边追球一边每帧都会走到 chase 分支，不冷却会连珠炮。
const BALL_LINES = {
  chase: ['球球等等我～', '我来啦！', '这次一定接住！', '别跑呀～', '让我来！'],
  kick:  ['看我的！', '走你～', '嘿——！', '踢飞它！'],
  cheer: ['我踢到啦！', '厉害吧～', '嘿嘿嘿～', '再来一次！', '球是我的啦～'],
  held:  ['还没扔吗？', '我准备好啦！', '往这边扔～', '快点嘛～', '我等着呢～'],
  ask:   ['扔给我嘛～', '快扔快扔！', '我要玩！', '扔这边！', '等不及啦～'],
  goal:  ['进球啦！', '我进啦！', '耶——！', '看到没有！', '再来一个！'],
  lose:  ['呜…', '就差一点…', '我不服！', '哼，再来！', '下次一定进！'],
  defend: ['我来守门！', '别想进球～', '我盯着呢！', '守住这边！'],
  block:  ['拦住了！', '不许进！', '看我的！', '挡住了～'],
};
const BALL_SAY_GAP = 6000;       // 同一场合两次说话至少隔这么久
let ballSaid = { chase: 0, kick: 0, cheer: 0, held: 0, ask: 0, goal: 0, lose: 0, defend: 0, block: 0 };

function ballSay(target, kind, ms){
  const now = Date.now();
  if(now - (ballSaid[kind] || 0) < BALL_SAY_GAP) return;
  const pool = BALL_LINES[kind];
  if(!pool || !pool.length) return;
  ballSaid[kind] = now;
  sendToDog(target, { type: 'say',
    text: pool[(Math.random() * pool.length) | 0], ms: ms || 1600 });
}

// 球一动（玩家扔出去 / 狗踢出去），两只狗的「追球台词」重新开闸 ——
// 否则说过一次之后整局都不再吭声。
function ballResetChaseSays(){
  [1, 2].forEach((t) => { if(ballDogs[t]) ballDogs[t].saidChase = false; });
}

// 谁会挂起两只狗的自主漫游：双人互动（meet）和桌面小球（ball.on）。
// 拖动、坠落这类**临时**状态结束时必须回落到这里，不能写死 false ——
// 写死的话，踢球踢到一半你顺手把狗拖一下再松手，漫游引擎就被放回来了，
// 狗会一边追球一边自己到处溜达。
function roamSuspendFrom(){ return !!ball.on || !!meet; }

function createBallWindow(){
  const size = ball.r * 2 + BALL_PAD * 2;
  // 一开始就摆在球该在的地方：先放 (0,0) 再 show 会闪一下
  const win = new BrowserWindow({
    x: Math.round(ball.x) - ball.r - BALL_PAD,
    y: Math.round(ball.y) - ball.r - BALL_PAD,
    width: size, height: size,
    transparent: true, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false,
    // 和两扇狗窗同一套：acceptFirstMouse 保证应用不在前台时第一下点击也算数，
    // 而且全程只用 showInactive() 显示 —— 不抢焦点（球只是桌面上一个玩具，
    // 没道理因为你点了它一把浏览器就失焦）。
    acceptFirstMouse: true, show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(APP_DIR, 'preload-ball.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  ballWin = win;
  // 默认整窗穿透：球只有四十来像素，不该因为它挡住底下的图标。
  // 光标压到球上时再打开（见 ballTick），和狗那套 hover 是同一个思路。
  win.setIgnoreMouseEvents(true, { forward: true });
  ball.interactive = false;
  if(process.platform !== 'win32'){
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  try { win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'normal'); }
  catch (_e) { win.setAlwaysOnTop(true); }
  win.loadFile(BALL_PAGE, { search: 'r=' + ball.r });
  win.once('ready-to-show', () => { if(!ball.held) showPetWindow(win); moveBallWindow(); });
  win.on('closed', () => { if(ballWin === win) ballWin = null; });
}

function createGoalWindow(side){
  const r = ballGoalRect(side);
  const win = new BrowserWindow({
    x: r.x, y: r.y, width: r.w, height: r.h,
    transparent: true, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, acceptFirstMouse: true, show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(APP_DIR, 'preload-goal.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  goalWins[side] = win;
  // 球门不吃鼠标：它贴在屏幕边沿，挡点击会很难受
  win.setIgnoreMouseEvents(true, { forward: true });
  if(process.platform !== 'win32'){
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  try { win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'normal'); }
  catch (_e) { win.setAlwaysOnTop(true); }
  win.loadFile(GOAL_PAGE, { search: 'side=' + side + '&name=' + encodeURIComponent(ballGoalName(side)) });
  win.once('ready-to-show', () => { showPetWindow(win); pushGoalScore(); });
  win.on('closed', () => { if(goalWins[side] === win) goalWins[side] = null; });
}

function destroyGoalWindows(){
  ['left', 'right'].forEach((side) => {
    const w = goalWins[side];
    if(w && !w.isDestroyed()) w.destroy();
    goalWins[side] = null;
  });
}

// 屏幕工作区变了（换分辨率 / 插拔显示器）→ 门跟着重新摆
function layoutGoalWindows(){
  if(!ball.on) return;
  ['left', 'right'].forEach((side) => {
    const w = goalWins[side];
    if(!w || w.isDestroyed()) return;
    const r = ballGoalRect(side);
    w.setBounds({ x: r.x, y: r.y, width: r.w, height: r.h });
  });
  moveBallWindow();
}

function pushGoalScore(){
  // 门牌显示的是「这扇门主人的总分」，所以按主人映射到左右
  const st = { left: ballScore[ballSideDog('left')] | 0,
               right: ballScore[ballSideDog('right')] | 0,
               serious: !!settings.ballSerious };
  ['left', 'right'].forEach((side) => {
    const w = goalWins[side];
    if(w && !w.isDestroyed()) w.webContents.send('goal:state', st);
  });
}

// 狗身挡球：把狗身当成一个圆（比轮廓略小，免得离老远就撞上）。只有**飞得快、
// 本来接不住**的球才弹 —— 慢球仍然走正常的「接住」逻辑。弹开之后球会掉速，
// 于是下一拍狗就追得上了。
function ballBlockCheck(now, s){
  if(ballCatchable(s)) return;
  const R = ball.r;
  [1, 2].forEach((t) => {
    const win = t === 2 ? pet2Win : petWin;
    if(!win || win.isDestroyed()) return;
    if(now < (ball.blockCd[t] || 0)) return;
    const g = t === 2 ? pet2Geometry() : geometry();
    const c = meetDogCenter(t);
    const bodyR = g.boxW * 0.36;                 // 狗身半径（轮廓的半宽是 0.5 boxW）
    const dx = ball.x - c.x, dy = ball.y - c.y;
    const dist = Math.hypot(dx, dy);
    if(dist > bodyR + R) return;
    const nx = dist > 0.001 ? dx / dist : 1;
    const ny = dist > 0.001 ? dy / dist : 0;
    // 先把球挪到狗身外面，再按镜面反射改速度（法向的 75% 弹回来）
    const need = bodyR + R + 2;
    ball.x = c.x + nx * need;
    ball.y = c.y + ny * need;
    const vn = ball.vx * nx + ball.vy * ny;
    if(vn < 0){
      ball.vx -= (1 + 0.75) * vn * nx;
      ball.vy -= (1 + 0.75) * vn * ny;
    }
    ball.vx *= 0.82; ball.vy *= 0.82;            // 挡一下会掉速，接着就能追
    ball.blockCd[t] = now + 320;
    ballSay(t, 'block', 1200);
  });
}

// 球进了哪个门？只在球**贴到墙的那一帧**判，而且高度必须落在门口范围内。
function ballGoalCheck(){
  const b = ballBounds();
  const R = ball.r;
  const l = ballGoalRect('left'), r = ballGoalRect('right');
  const inMouth = (g) => ball.y > g.y + R * 0.55 && ball.y < g.y + g.h - R * 0.55;
  if(ball.x - R <= b.x + 3 && inMouth(l)) return 'left';
  if(ball.x + R >= b.x + b.width - 3 && inMouth(r)) return 'right';
  return null;
}

// 进球。两种模式的处理不一样：
//   娱乐赛：球马上回到场地正中，门的主人原地高兴一下，其它狗接着抢
//   认真赛：**胜者做积极动作、败者做消极动作**，演完各回固定位置，再重新开球
function ballScoreGoal(side){
  const b = ballBounds();
  const g = ballGoalRect(side);
  const now = Date.now();
  // 球只要进入左/右球门就正常计分，不再做“自家门进球不计分”的特殊兜底。
  // 防止小狗主动朝自家门踢仍由 ballPickKick 的方向约束负责。
  const serious = !!settings.ballSerious;
  // 破的是 side 这扇门 → 这扇门的**主人**丢分，**对手**得分
  const owner = ballSideDog(side);            // 丢分的那只（守自家门的）
  const winner = ballScorerOf(side);          // 得分的那只（把球踢进对面门的）
  ballScore[winner] = (ballScore[winner] | 0) + 1;
  pushGoalScore();                            // 先加分再刷门牌，别差一拍
  // 先把两只狗的临时状态清干净
  [1, 2].forEach((t) => {
    if(ballDogs[t]){ ballDogs[t].phase = 'chase'; ballDogs[t].askDone = false;
                     ballDogs[t].askUntil = 0; ballDogs[t].saidChase = false; }
  });
  const alive = (t) => {
    const w = t === 2 ? pet2Win : petWin;
    return !!(w && !w.isDestroyed());
  };

  if(serious){
    // —— 认真赛：胜者积极 / 败者消极 → 回固定位置 → 重新开球 ——
    const cheer = BALL_CHEERS[(Math.random() * BALL_CHEERS.length) | 0];
    const sad = BALL_SADS[(Math.random() * BALL_SADS.length) | 0];
    ballKickoff = { phase: 'act', t0: now,
                    until: now + Math.max(cheer.ms, sad.ms) + 300,
                    winner: winner, loser: owner };
    ball.held = true;              // 仪式期间球不在场上
    ball.vx = 0; ball.vy = 0;
    ball.interactive = false;
    if(ballWin && !ballWin.isDestroyed()){
      ballWin.setIgnoreMouseEvents(true, { forward: true });
      ballWin.hide();
    }
    if(alive(winner)){
      ballDogs[winner] = { phase: 'goalWin', t0: now, dir: 1, saidChase: true };
      sendToDog(winner, { type: 'driven', state: cheer.state, dir: 1 });
      ballSay(winner, 'goal', 1900);
    }
    if(alive(owner)){
      ballDogs[owner] = { phase: 'goalLose', t0: now, dir: -1, saidChase: true };
      sendToDog(owner, { type: 'driven', state: sad.state, dir: -1 });
      ballSay(owner, 'lose', 1900);
    }
  } else {
    // —— 娱乐赛：原样 ——
    ball.x = Math.round(b.x + b.width / 2);
    ball.y = Math.round(g.y + g.h / 2);
    ball.vx = 0; ball.vy = 0;
    ball.held = false;
    ball.grabbed = false;
    ball.noCatchUntil = now + 800;       // 刚开球别被一口叼走
    moveBallWindow();
    if(alive(winner)){
      const pick = BALL_CHEERS[(Math.random() * BALL_CHEERS.length) | 0];
      ballDogs[winner] = { phase: 'cheer', t0: now, dir: 1,
                           cheerMs: pick.ms, saidChase: true };
      sendToDog(winner, { type: 'driven', state: pick.state, dir: 1 });
      ballSay(winner, 'goal', 1900);
    }
  }
  snapshotToConsole();
}

// 认真赛进球后的仪式：先演动作，再各回固定位置（左 25% / 右 75%），齐了才重新开球
function ballKickoffTick(dt, now, s){
  const k = ballKickoff;
  if(!k) return;
  const b = ballBounds();
  const ground = ballGroundY();
  if(k.phase === 'act'){
    if(now >= k.until){ k.phase = 'home'; k.homeT0 = now; }
    return;                                  // 动作期间就站在原地演
  }
  // —— 回固定位置 ——
  // 固定点：小金毛在场地左侧 25%、小白在右侧 75%（和开局站位一致），都站在地面线上
  const spots = [[1, b.x + b.width * 0.25], [2, b.x + b.width * 0.75]];
  let allHome = true;
  spots.forEach(([t, tx]) => {
    const w = t === 2 ? pet2Win : petWin;
    if(!w || w.isDestroyed()) return;
    const gg = t === 2 ? pet2Geometry() : geometry();
    const ty = ground - gg.boxH / 2;
    const c = meetDogCenter(t);
    const d = Math.hypot(tx - c.x, ty - c.y);
    if(d > 10){
      allHome = false;
      sendToDog(t, { type: 'driven', state: 'run', dir: tx >= c.x ? 1 : -1 });
      ballMoveDogToward(t, tx, ty, dt);
    } else {
      sendToDog(t, { type: 'driven', state: 'idle', dir: tx >= c.x ? 1 : -1 });
      ballPlaceDogCenter(t, tx, ty);
    }
  });
  if(!allHome) return;
  // —— 全都站好了 → 重新开球：球出现在场地正中 ——
  const g0 = ballGoalRect('left');
  ball.x = Math.round(b.x + b.width / 2);
  ball.y = Math.round(g0.y + g0.h / 2);
  ball.vx = 0; ball.vy = 0;
  ball.held = false;
  ball.grabbed = false;
  ball.noCatchUntil = now + 600;             // 刚开球别被一口叼走
  ballDogs[1] = null; ballDogs[2] = null;    // 回到正常追球
  ballKickoff = null;
  ballResetChaseSays();
  moveBallWindow();
  showPetWindow(ballWin);
  snapshotToConsole();
}

function moveBallWindow(){
  if(!ballWin || ballWin.isDestroyed()) return;
  const size = ball.r * 2 + BALL_PAD * 2;
  ballWin.setBounds({ x: Math.round(ball.x) - ball.r - BALL_PAD,
                      y: Math.round(ball.y) - ball.r - BALL_PAD,
                      width: size, height: size });
}

function startBallGame(){
  if(ball.on) return;
  if(meet) meetAbort();
  if(easterEggWin && !easterEggWin.isDestroyed()) easterEggWin.destroy();
  const wa = workArea();
  ball.on = true;
  ball.grabbed = false;
  ball.held = false;
  ball.samples = [];
  ball.r = ballRadius();
  // 和进球后重新开球一致：球放在场地正中、门口那个高度
  const g0 = ballGoalRect('left');
  const bb0 = ballBounds();
  ball.x = Math.round(bb0.x + bb0.width * 0.5);
  ball.y = Math.round(g0.y + g0.h * 0.5);
  ball.vx = 0; ball.vy = 0;
  ballKickoff = null;
  ball.noCatchUntil = 0;
  ball.blockCd = { 1: 0, 2: 0 };
  ballSaid = { chase: 0, kick: 0, cheer: 0, held: 0, ask: 0, goal: 0, lose: 0, defend: 0, block: 0 };
  ballDogs[1] = null; ballDogs[2] = null;
  if(ballWin && !ballWin.isDestroyed()){ ballWin.destroy(); ballWin = null; }
  destroyGoalWindows();
  createBallWindow();
  createGoalWindow('left');
  createGoalWindow('right');
  // **开局也把两只摆到各自半场的固定点**（小金毛 25% 左、小白 75% 右）。
  // 以前是让它们从各自漫游的位置出发 —— 而小白平时就站在小金毛右边一点，
  // 球又在场地正中，于是开局几乎总是小白先够到球、先得分（用户反馈「基本
  // 都是小白赢」）。摆到对称的两个点上，第一脚才是公平的。
  {
    const ground0 = ballGroundY();
    const spots0 = [[1, bb0.x + bb0.width * 0.25], [2, bb0.x + bb0.width * 0.75]];
    spots0.forEach(([t, tx]) => {
      const w = t === 2 ? pet2Win : petWin;
      if(!w || w.isDestroyed()) return;
      const gg = t === 2 ? pet2Geometry() : geometry();
      ballPlaceDogCenter(t, tx, ground0 - gg.boxH / 2);
    });
  }
  // 漫游引擎让开：这两只狗现在是「在追球」，位置全由 ballTick 编
  roamSuspended = true;
  pet2Suspended = true;
  ballLastTick = 0;
  if(ballTimer) clearInterval(ballTimer);
  ballTimer = setInterval(ballTick, 16);
  snapshotToConsole();
}

function stopBallGame(){
  if(!ball.on) return;
  ball.on = false;
  if(ballTimer){ clearInterval(ballTimer); ballTimer = null; }
  ball.grabbed = false;
  ball.held = false;
  if(ballWin && !ballWin.isDestroyed()) ballWin.destroy();
  ballWin = null;
  destroyGoalWindows();
  // 把两只狗交还给各自的自动活动
  sendPet({ type: 'driven', state: null });
  sendPet2({ type: 'driven', state: null });
  ballDogs[1] = null; ballDogs[2] = null;
  ballKickoff = null;
  roamSuspended = false;
  pet2Suspended = false;
  snapshotToConsole();
}

// 控制台「大小」改了 → 球也得跟着变大小（换尺寸只能重建那扇小窗）
function syncBallSize(){
  if(!ball.on) return;
  const r = ballRadius();
  if(r === ball.r) return;
  ball.r = r;
  if(ballWin && !ballWin.isDestroyed()){ ballWin.destroy(); ballWin = null; }
  createBallWindow();
  const bb = ballBounds();
  ball.x = clamp(ball.x, bb.x + r, bb.x + bb.width - r);
  ball.y = clamp(ball.y, bb.y + r, bb.y + bb.height - r);
  moveBallWindow();
}

function ballTick(){
  if(!ball.on) return;
  const now = Date.now();
  const dt = Math.min(0.05, (now - (ballLastTick || now)) / 1000);
  ballLastTick = now;
  // 球窗被外面关掉/销毁了（换屏幕、异常退出）→ 当作「收球」，别留下挂起的狗
  if(!ballWin || ballWin.isDestroyed()){ stopBallGame(); return; }
  const s = ballScale();
  const R = ball.r;
  const b = ballBounds();

  // 光标压到球上才让这扇窗收鼠标；离开立刻恢复穿透（不然会挡住桌面图标）。
  // **拖动过程中绝对不要碰这个开关**：一旦中途改成穿透，后面的 mouseup 就
  // 落到别的窗口上去了，球会「粘在手上」放不开（狗那边踩过同一个坑）。
  if(!ball.grabbed && !ball.held){
    const c = screen.getCursorScreenPoint();
    const over = c.x >= ball.x - R - BALL_PAD && c.x <= ball.x + R + BALL_PAD &&
                 c.y >= ball.y - R - BALL_PAD && c.y <= ball.y + R + BALL_PAD;
    if(over !== ball.interactive){
      ball.interactive = over;
      ballWin.setIgnoreMouseEvents(!over, { forward: true });
    }
  }

  if(ball.grabbed){
    const c = screen.getCursorScreenPoint();
    const vr = ballVerticalRange();
    ball.x = clamp(c.x - ball.grabDX, b.x + R, b.x + b.width - R);
    ball.y = clamp(c.y - ball.grabDY, vr.min, vr.max);
    ball.vx = 0; ball.vy = 0;
    ball.samples.push({ x: ball.x, y: ball.y, t: now });
    while(ball.samples.length > 2 && now - ball.samples[0].t > 140) ball.samples.shift();
    if(ball.samples.length > 16) ball.samples.shift();
  } else if(!ball.held){
    // **没有重力**：不加速度，就是匀速直线走，只按秒衰减一点速度
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    const damp = Math.pow(BALL_DAMP, dt);
    ball.vx *= damp;
    ball.vy *= damp;
    if(Math.hypot(ball.vx, ball.vy) < BALL_STOP * s){ ball.vx = 0; ball.vy = 0; }
    // 撞到所有屏幕并集的外沿才回弹（screen 之间可以自由穿过）
    const vr = ballVerticalRange();
    if(ball.y < vr.min){ ball.y = vr.min; ball.vy = Math.abs(ball.vy) * BALL_BOUNCE; }
    if(ball.y > vr.max){ ball.y = vr.max; ball.vy = -Math.abs(ball.vy) * BALL_BOUNCE; }
    if(ball.x - R < b.x){ ball.x = b.x + R; ball.vx = Math.abs(ball.vx) * BALL_BOUNCE; }
    if(ball.x + R > b.x + b.width){ ball.x = b.x + b.width - R; ball.vx = -Math.abs(ball.vx) * BALL_BOUNCE; }
    if(ball.y - R < b.y){ ball.y = b.y + R; ball.vy = Math.abs(ball.vy) * BALL_BOUNCE; }
    if(ball.y + R > b.y + b.height){ ball.y = b.y + b.height - R; ball.vy = -Math.abs(ball.vy) * BALL_BOUNCE; }
  }

  // **狗身挡球**：飞得快的球（接不住的那种）撞到狗身上会被弹开 —— 这就是「守门」。
  // 少了这一步，守门的狗只是个摆设：球直接从它身上穿过去进门（用户反馈的
  // 「靠近了也拦不住、变成你进一次我进一次」）。
  if(!ball.held && !ball.grabbed) ballBlockCheck(now, s);

  // 进球判定：球撞到左/右墙、而且高度在门口范围内 → 算进
  if(!ball.held && !ball.grabbed){
    const scored = ballGoalCheck();
    if(scored){ ballScoreGoal(scored); return; }
  }

  moveBallWindow();
  // 球压在狗上面（不然被狗挡住就抓不到），两个球门再压在球上面
  //（球进网那一下才有「进去了」的感觉）。moveTop 不抢焦点，隔一会儿抬一次就够。
  if(now - ball.lastTop > 700){
    ball.lastTop = now;
    if(ballWin.isVisible()) ballWin.moveTop();
    ['left', 'right'].forEach((side) => {
      const w = goalWins[side];
      if(w && !w.isDestroyed() && w.isVisible()) w.moveTop();
    });
  }

  ballDogsTick(dt, now, s);
}

// 没有重力之后，「能不能接」只看球够不够慢 —— 球是匀速直线走的，
// 不减速就永远追不上，减速到 BALL_CATCH_SPEED 以下才允许狗把它叼走。
function ballCatchable(s){
  return Math.hypot(ball.vx, ball.vy) < BALL_CATCH_SPEED * s;
}

function ballDogsTick(dt, now, s){
  if(ballKickoff){ ballKickoffTick(dt, now, s); return; }
  const R = ball.r;
  const targets = [1, 2].filter((t) => {
    const win = t === 2 ? pet2Win : petWin;
    return win && !win.isDestroyed();
  });
  const kicker = targets.find((t) => ballDogs[t] &&
                    (ballDogs[t].phase === 'align' || ballDogs[t].phase === 'kick')) || null;

  targets.forEach((t) => {
    const st = ballDogs[t] || (ballDogs[t] = { phase: 'chase', t0: 0, dir: 1 });
    const gg0 = t === 2 ? pet2Geometry() : geometry();
    const c = meetDogCenter(t);
    const dir = ball.x >= c.x ? 1 : -1;
    // 够球距离给到「半个身位 + 一点」：比这更近才接。之前用的是踢球偏移 + 半径，
    // 屏幕角上会出现「狗被边界夹住、球就在头顶但够不着」的死角。
    const reach = gg0.boxW * 0.5 + R * 0.15;

    if(st.phase === 'chase'){
      // **球被另一只叼走了 → 不要发呆，去守门**（用户要求）。
      // 守哪扇门？叼球那只瞄准的是**它自己的门**（进了算它得分），所以另一只要
      // 守的就是那扇门 —— 也就是防守方自己的门（叼球那只往对面冲）。
      if(ball.held){
        // 叼球那只正在往**它对面那扇门**冲 —— 那扇门就是「防守方自己的门」，
        // 所以守门守住的就是它（守门的那只站在自己门那一侧，和开场站位一致）。
        const carrier = [1, 2].find((x) => ballDogs[x] && ballDogs[x].phase !== 'chase');
        const defSide = carrier ? ballAttackSide(carrier) : null;
        if(defSide){
          const dg = ballGoalRect(defSide);
          const bb = ballBounds();
          const gg = t === 2 ? pet2Geometry() : geometry();
          // 门口前 8% 场地宽度，最多 168px。比原来的 260px 更贴近门线，
          // 小狗的身形才能真正盖住门前区域。
          const inset = Math.min(bb.width * 0.08, 168 * s);
          const tx = defSide === 'left' ? dg.x + dg.w + inset : dg.x - inset;
          // 不再死守门正中央：跟着球的上下位置预判射门线，偏 60% 靠向球，
          // 40% 留在门中间，避免被远角直接绕开。
          const goalCenterY = dg.y + dg.h / 2;
          const guardBallY = goalCenterY + (ball.y - goalCenterY) * 0.60;
          const halfH = gg.boxH / 2;
          const guardMin = dg.y + halfH;
          const guardMax = dg.y + dg.h - halfH;
          const ty = (guardMax > guardMin ? clamp(guardBallY, guardMin, guardMax)
                                          : goalCenterY) - halfH;
          const dc = meetDogCenter(t);
          const dd = Math.hypot(tx - dc.x, ty - dc.y);
          if(dd > 12){
            sendToDog(t, { type: 'driven', state: 'run', dir: tx >= dc.x ? 1 : -1 });
            // 小白回防稍微加一点速，减少“看见射门但来不及站住”的情况。
            ballMoveDogToward(t, tx, ty, dt, t === 2 ? 1.10 : 1.0);
            ballSay(t, 'defend', 1500);
          } else {
            // 已经站到门口了：面朝叼球那只，守着
            sendToDog(t, { type: 'driven', state: 'idle',
                           dir: dc.x <= meetDogCenter(carrier).x ? 1 : -1 });
          }
          return;
        }
        sendToDog(t, { type: 'driven', state: 'idle', dir: dir });
        return;
      }
      // **玩家把球拿在手里**：小狗会追着你手里的球跑过来（互动感的核心），
      // 凑到手边之后再随机做一个小动作「求你扔」。每抓起一次只求一次，
      // 不然它会一直原地转圈。
      if(ball.grabbed){
        // 停在你手边的距离。**调小了**（0.85 → 0.45）：原来留半个身位，
        // 你举着球的时候狗会在离球一大截的地方就站住 —— 用户看到的
        // 「狗身没有上去」就是这个。现在它会一直凑到贴着球，
        // 头基本和球齐平/略高，看着才像在跟你要球。
        const nearHand = Math.hypot(ball.x - c.x, ball.y - c.y) <= reach * 0.45;
        if(!nearHand){
          st.askDone = false; st.askUntil = 0;
          sendToDog(t, { type: 'driven', state: 'run', dir: dir });
          ballMoveDogToward(t, ball.x, ball.y, dt);
          if(!st.saidChase){ st.saidChase = true; ballSay(t, 'chase', 1500); }
          return;
        }
        if(st.askUntil && now < st.askUntil){ return; }     // 这一下还没演完
        if(!st.askDone && now - (ball.grabAt || now) > 800){
          st.askDone = true;
          const ask = BALL_ASKS[(Math.random() * BALL_ASKS.length) | 0];
          st.askUntil = now + ask.ms;
          sendToDog(t, { type: 'driven', state: ask.state, dir: dir });
          ballSay(t, 'ask', 1700);
          return;
        }
        st.askUntil = 0;
        sendToDog(t, { type: 'driven', state: 'idle', dir: dir });
        return;
      }
      // **追的是「踢球该站的那个位置」，不是球本身**。追球本身的话，「够得着」
      // 的判定距离有半个身位那么远，狗会在离球一大截的地方就停下接球 —— 用户看到
      // 的「跑到上界面一定距离就停住」就是这么来的。改成追落点之后，它会一直贴到
      // 能贴的最近处，接球时其实已经站好了，踢出去也不会再瞬移。
      const off = ballKickOffset(t);
      const spotX = ball.x - dir * off.dx;
      const spotY = ball.y + off.dy - gg0.boxH / 2;
      const canCatch = now >= ball.noCatchUntil;
      const before = meetDogCenter(t);
      sendToDog(t, { type: 'driven', state: 'run', dir: dir });
      ballMoveDogToward(t, spotX, spotY, dt);
      const after = meetDogCenter(t);
      // 一步挪不动（被屏幕边/球门夹住）→ 记一笔，连着几帧就当它「已经站到位了」
      if(Math.hypot(after.x - before.x, after.y - before.y) < 0.35) st.stuck = (st.stuck || 0) + 1;
      else st.stuck = 0;
      // 一边跑一边说点什么（每个「球动起来」的回合最多一句）
      if(!st.saidChase){ st.saidChase = true; ballSay(t, 'chase', 1500); }
      const toSpot = Math.hypot(spotX - after.x, spotY - after.y);
      const toBall = Math.hypot(ball.x - after.x, ball.y - after.y);
      const inPlace = toSpot <= 12 || (st.stuck >= 3 && toBall <= reach);
      // 球还太快（追不上）/ 刚踢出去不许接 / 还没站到位 → 继续追
      if(!canCatch || !ballCatchable(s) || !inPlace) return;
      // 已经在球边上了：如果另一只已经进入接球/踢球阶段，就让开，避免同一轮
      // 两只同时操作；除此之外不再按“上一轮谁踢过”做轮流让位 —— 谁先到谁踢。
      if(kicker && kicker !== t){ sendToDog(t, { type: 'driven', state: 'idle', dir: dir }); return; }
      // 接到球：**球先消失**（狗叼住了），站到位、踢出去，踢完才做积极动作。
      // 这一脚往哪儿踢在**这一刻**就定下来 —— 后面的「站到位」要靠它决定
      // 狗该站球的哪一侧、朝哪边踢。
      st.aim = ballPickKick(t);
      st.dir = st.aim.dir || st.aim.flip || 1;
      st.phase = 'align'; st.t0 = now;
      ball.held = true;
      ball.vx = 0; ball.vy = 0;
      ball.interactive = false;
      ballWin.setIgnoreMouseEvents(true, { forward: true });
      ballWin.hide();
      // 「站到位」这一小步要用**走路**姿态，不能用 idle —— 用 idle 的话狗会站着
      // 不动最多 0.4 秒（用户看到的「拿到球之后发呆一下」）。
      sendToDog(t, { type: 'driven', state: 'walk', dir: dir });
      return;
    }

    if(st.phase === 'align'){
      // 站到位：让「踢球那一帧」里那颗画上去的球正好落在物理球原来的位置
      // （x 差半个球、y 差「球心到脚底」那 44 像素），这样球消失、球回来都看不出跳。
      const gg = t === 2 ? pet2Geometry() : geometry();
      const off = ballKickOffset(t);
      const wantX = ball.x - st.dir * off.dx;
      const wantY = ball.y + off.dy - gg.boxH / 2;
      const cur = meetDogCenter(t);
      const dx = wantX - cur.x, dy = wantY - cur.y;
      if(Math.hypot(dx, dy) > 0.5 && now - st.t0 < 400){
        const step = Math.min(1, 340 * s * dt / Math.max(1, Math.hypot(dx, dy)));
        ballPlaceDogCenter(t, cur.x + dx * step, cur.y + dy * step);
        return;
      }
      st.phase = 'kick'; st.t0 = now;
      sendToDog(t, { type: 'driven', state: 'kick', dir: st.dir });
      ballSay(t, 'kick', 700);          // 起脚那一下喊一声（等球飞出去就说另一句了）
      return;
    }

    if(st.phase === 'kick'){
      if(now - st.t0 >= BALL_KICK_MS){
        // 踢完这一脚：球回到画面里那颗球的位置，然后按接球时抽好的角度飞出去
        const gg = t === 2 ? pet2Geometry() : geometry();
        const off = ballKickOffset(t);
        const c2 = meetDogCenter(t);
        ball.x = c2.x + st.dir * off.dx;
        ball.y = (c2.y + gg.boxH / 2) - off.dy;
        const aim = st.aim || {};
        const bb = ballBounds();
        // 认真赛模式：球更快（踢出去的初速整体 ×1.6），而且踢完不庆祝
        const serious = !!settings.ballSerious;
        const pow = serious ? 1.6 : 1;
        if(aim.side){
          // 瞄准球门：从球现在的位置指向门口那个点。力度按距离给 —— 球每秒
          // 衰减到一半，总行程约 1.44×初速，所以得跟距离挂钩，不然远门永远踢不到。
          const wallX = aim.side === 'left' ? bb.x : bb.x + bb.width;
          const dx = wallX - ball.x, dy = aim.ty - ball.y;
          const len = Math.hypot(dx, dy) || 1;
          // 初速按**场地距离**给（不乘狗的大小）：球要跨过的是屏幕距离，
          // 跟狗多小没关系。以前乘了 dog scale，狗调小之后（比如 40%）上限被压到
          // 1040px/s，远一点的射门根本到不了门口，球总在中场打转。
          const spd = clamp(len * 1.1, 900, 3200) * pow;
          ball.vx = dx / len * spd;
          ball.vy = dy / len * spd;
        } else {
          // 乱踢那一档同样按场地算，不乘狗的大小
          const spd = (aim.spd || 1600) * pow;
          ball.vx = Math.cos(aim.ang || 0) * spd * (aim.flip || st.dir);
          ball.vy = Math.sin(aim.ang || 0) * spd;
        }
        ball.held = false;
        // 先飞一会儿别被原地叼回来；**瞄准球门的那一脚给更长的免接时间**，
        // 不然球在飞向球门的路上减速到可接速度，会被自己（或另一只）半路截胡，
        // 十脚有八脚到不了门口。
        ball.noCatchUntil = now + (aim.side ? 2200 : BALL_NOCATCH_MS);
        moveBallWindow();
        showPetWindow(ballWin);
        ballResetChaseSays();                        // 球飞了，两只狗的追球台词重新开闸
        if(serious){
          // 认真赛：**不庆祝**，球一飞出去立刻掉头接着追（球也更快，追得更凶）
          ballDogs[t] = { phase: 'chase', t0: now, dir: st.dir, saidChase: true };
        } else {
          // 娱乐赛：**球飞出去之后**才原地做积极动作（先踢飞、再高兴），
          // 做完这一下才回去继续追。做哪个动作是随机挑的。
          const pick = BALL_CHEERS[(Math.random() * BALL_CHEERS.length) | 0];
          st.phase = 'cheer'; st.t0 = now; st.cheerMs = pick.ms;
          sendToDog(t, { type: 'driven', state: pick.state, dir: st.dir });
          ballSay(t, 'cheer', 1700);
        }
      }
      return;
    }

    if(st.phase === 'cheer'){
      // 球已经飞走了，这只狗站在原地把这段积极动作做完再接着追
      if(now - st.t0 >= (st.cheerMs || BALL_CHEER_MS)){
        ballDogs[t] = { phase: 'chase', t0: now, dir: st.dir, saidChase: true };
      }
      return;
    }
  });
}

// 点击退出时：两只狗先跑到一起，再播「我们出去玩啦」双狗动作，播完退出。
function farewellThenQuit(){
  if (farewellQuitting) return;
  farewellQuitting = true;
  stopBallGame();                       // 球还在地上就先收掉，别挡着告别动画
  if (easterEggWin && !easterEggWin.isDestroyed()) easterEggWin.destroy();
  if (meet) meetAbort();
  if (!startMeet('goOut', { bothRun: true, quitAfter: true })) {
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// 漫游引擎：60Hz 把窗口推着走
// ---------------------------------------------------------------------------
let lastTick = 0;
let bumpCooldown = 0;
let lastCursorPush = 0;

// 下落：松手之后窗口落回地面线。位置与速度都由主进程管 —— 页面那边只知道
// 「正在掉」，它负责播掉落姿态和落地那一下的压缩/扬尘（见 'land' 指令）。
let fallVy = 0;
let falling = false;

// 页面里的重力是 1950「舞台单位/秒²」，而舞台宽 300 单位 = boxW 像素。
// 换算成屏幕像素，两边的自由落体手感才一致（不换算的话窗口像在月球上飘）。
const pxPerUnit = (g) => g.boxW / 300;
const fallG = (g) => 1950 * pxPerUnit(g);

let petBoundsCache = null, petBoundsAt = 0;
let lastIdleCursorAt = 0;
let lastIdleTickAt = 0;
function tick() {
  const now = Date.now();
  // 性能治理：用户离开（idle/deep idle）时主循环降到 10Hz，省 CPU
  if (v2 && v2.engines && v2.engines.idle && v2.engines.idle.mode !== 'normal') {
    if (now - lastIdleTickAt < 100) return;
    lastIdleTickAt = now;
  }
  goose.tick(now);   // 捣蛋行为钩子（叼鼠标/报复/脚印）
  if (v2) v2.tick(now);   // V2 节拍（状态结算/事件/关系/记忆）
  // 用户活跃检测：1 秒采样一次光标位置（变位 = 活跃）
  if (v2 && v2.engines && v2.engines.idle && now - lastIdleCursorAt >= 1000) {
    lastIdleCursorAt = now;
    const _c = screen.getCursorScreenPoint();
    v2.engines.idle.sampleCursor(_c.x, _c.y);
  }
  const dt = Math.min(0.05, (now - (lastTick || now)) / 1000);
  lastTick = now;
  if (!petWin || petWin.isDestroyed()) return;

  const g = geometry();
  // 以操作系统里的真实窗口坐标为准，而不是长期缓存的 roamX/roamY。
  // 动作切换、缩放和工作区切换都可能让实际 bounds 与缓存值暂时分家；
  // 不重新同步的话，后续计算会沿着错误位置继续漂移。
  // getBounds 是原生调用，60Hz 下每次都问太浪费 —— 缓存 50ms（≈3 帧，
  // 漫游位移仅 1~2px，无感），省掉 60Hz 里的大部分原生调用。
  if (!petBoundsCache || now - petBoundsAt >= 50) {
    petBoundsCache = petWin.getBounds();
    petBoundsAt = now;
  }
  const actual = petBoundsCache;
  const range = roamRange(g);
  // 竖直的两个边界每帧都要用，算一次就够（workArea 是原生调用，别在 60Hz 里反复问）
  const top = yTop(g), bot = yBottom(g);

  // 跟随鼠标开着的时候，把光标的窗口内 x/y 发给页面做姿态判断；
  // 真正搬窗口的 2D 追随在下面，直接按屏幕坐标逼近，不再只追 x。
  const walking = petState.state === 'walk' || petState.state === 'run';
  let followCursor = null;
  if (settings.follow) {
    followCursor = screen.getCursorScreenPoint();
    if (now - lastCursorPush >= 50) {
      lastCursorPush = now;
      sendPet({ type: 'cursor', x: followCursor.x - roamX, y: followCursor.y - roamY });
    }
  }

  // 拖拽中窗口完全由光标驱动（dragTimer 每 16ms setBounds），两个轴都别插手 ——
  // 不然 tick 会每秒 60 次把它拽回地面线/原处，根本拖不动。
  if (dragTimer) return;
  // 踢球期间窗口位置全归 ballTick：这里的夹取只认「狗当前所在的那一块屏」，
  // 留着它狗就永远追不到另一个屏幕上的球（用户要求全部屏幕都能踢）。
  if (ball.on) return;

  // 追随模式保持整窗鼠标穿透。狗可以追到光标下面，但点击必须继续落到
  // 它身后的窗口/图标上；需要点狗时先关闭“跟随鼠标”。
  if (settings.follow && mouseShouldPassThrough(1) && interactive) {
    interactive = false;
    setIgnoreMouse(true);
  }
  const followActive = settings.follow && !roamSuspended && !falling;
  if (!settings.roam || roamSuspended || !walking) roamVx = 0;

  // 只在窗口被外部移动（跨屏、系统搬动、拖动入口等）时同步缓存坐标。
  // 不能每帧无条件回写：setBounds 是取整的，小尺寸下一次只走 0.2~0.5px，
  // 回写会把小数部分清零，横向看起来就是永远原地踏步。
  if (!followActive && roamVx === 0 && Math.abs(roamX - actual.x) > 2) roamX = actual.x;
  // 【别改成 roamY + 移位！】实际窗口 y = max(roamY, 夹取线)，移位那段是画在
  // 页面里的、不体现在窗口坐标上。拿 roamY+移位 去比，被夹住时 roamY 会被每帧
  // 拽回夹取线附近，在两像素之间来回跳，移位跟着跳 358/360，页面里的狗就频闪。
  // 要按「期望的窗口 y」比：夹取线以内就是 roamY 本身。
  const expectWinY = Math.max(roamY, workArea().y);
  if (!falling && Math.abs(expectWinY - actual.y) > 2) roamY = actual.y - dogShift[1];

  if (!followActive && roamVx !== 0) {
    roamX += roamVx * dt;
    let bumped = null;
    if (roamX <= range.min) { roamX = range.min; bumped = 'left'; }
    if (roamX >= range.max) { roamX = range.max; bumped = 'right'; }

    if (bumped && now > bumpCooldown) {
      bumpCooldown = now + 450;                 // 别在边界上反复横跳
      sendPet({ type: 'bump', side: bumped });
      settings.x = Math.round(roamX);
      saveSettings();
    }
  }

  // —— 竖直：2D 漫游 ——
  // 竖直方向也要走，不然狗一辈子贴着屏幕上沿/下沿那条线「走」，看起来像被粘在
  // 桌边。做法是每隔几秒在工作区里挑一个新的目标高度，然后以水平速度的一个系数
  // 斜着走过去 —— 视觉上就是「沿着一条看不见的坡溜达上去/下来」。
  // **重力只归「松手掉落」那一下**（falling 分支），平时不施重力：不然刚走上去
  // 就掉下来，永远只能待在底部。
  const b = actual;
  let y;
  // 兜底：坠落模式被关掉时还在下落 —— 立刻停住，别继续掉下去。
  // 正常路径在 console:set / 托盘里就把它停了，这里防的是边角（比如设置文件里
  // 就是关的、或者以后多了别的入口忘了停）。
  if (falling && !settings.fall) {
    falling = false;
    fallVy = 0;
    sendPet({ type: 'stand' });
  }
  if (falling) {
    const land = fallGroundY(1);    // 最多掉到屏幕底边，别掉出屏幕
    fallVy += fallG(g) * dt;
    y = b.y + fallVy * dt;
    if (y >= land) {
      y = land;
      const impact = fallVy;        // 落地瞬间的速度：页面拿它算压缩幅度与扬尘
      falling = false; fallVy = 0;
      roamTargetY = null;           // 落了地就重新挑高度
      sendPet({ type: 'land', vy: impact / pxPerUnit(g) });
    }
    roamY = y;
  } else if (followActive && followCursor) {
    // 让狗的中心对准光标；窗口上方留了起跳/气泡空间，所以不能直接把窗口中心
    // 当成狗中心，否则视觉上会偏低一大截。
    const dogCX = Number(petState.centerX) >= 0 ? Number(petState.centerX)
                                                   : PAD_X + g.boxW / 2;
    const dogCY = Number(petState.centerY) >= 0 ? Number(petState.centerY)
                                                   : g.winH - FOOT - g.boxH / 2;
    const targetX = followCursor.x - dogCX;
    const targetY = followCursor.y - dogCY;
    const dx = targetX - roamX;
    const dy = targetY - roamY;
    const dist = Math.hypot(dx, dy);
    if (dist > 4) {
      const speed = FOLLOW_SPEED * settings.speedMul;
      const step = Math.min(dist, speed * dt);
      roamX = clamp(roamX + dx / dist * step, range.min, range.max);
      roamY = clamp(roamY + dy / dist * step, top, bot);
    }
    roamTargetY = null;
    y = roamY;
  } else if (walking && roamVx !== 0) {
    if (roamTargetY === null ||
        (now > nextYPick && Math.abs(roamY - roamTargetY) < 8)) {
      const roamBot = Math.max(top, bot - (IS_WIN ? 24 : 0));
      roamTargetY = top + Math.random() * Math.max(1, roamBot - top);
      nextYPick = now + 2500 + Math.random() * 3500;
    }
    // 竖直速度取「水平速度的一定比例」和「至少 26 秒爬完整个可用高度」里的大者。
    // 只按比例会有个坑：狗调小之后水平速度也按比例变小（速度是按舞台单位定的），
    // 竖直就只剩 17px/s —— 爬满一屏要 40 秒，看起来像卡住了。
    const vy = Math.max(Math.abs(roamVx) * VY_RATIO, (bot - top) / 26);
    const step = clamp(roamTargetY - roamY, -vy * dt, vy * dt);
    roamY = clamp(roamY + step, top, bot);
    y = roamY;
  } else {
    // 没在走就停在原地 —— 竖直方向不施重力（重力只属于「松手掉落」）
    y = roamY;
  }

  // 所有分支最后的强制夹取。特别是 setBounds 使用的是局部 y，夹完必须同步，
  // 否则这一帧仍会把夹取前的高度写回窗口。
  if (!falling) {
    const safeTop = yTop(g), safeBottom = yBottom(g);
    roamY = clamp(roamY, safeTop, safeBottom);
    y = roamY;
  }

  const x = Math.round(roamX);
  y = Math.round(y);
  const winY = Math.round(applyDogShift(1, y));   // 窗口顶到上限之后改挪狗
  if (x !== b.x || winY !== b.y) {
    // Windows 150% DPI 下，getBounds() 的物理像素宽高再传给 setBounds() 会被
    // 当成逻辑像素，每帧乘一次缩放比例，窗口会指数膨胀并跑到屏幕外。
    // 尺寸必须始终使用 geometry() 算出的逻辑尺寸。
    petWin.setBounds({ x: x, y: winY, width: g.winW, height: g.winH });
  }
}


// ---------------------------------------------------------------------------
// 两狗分离：除双人互动外不允许重叠。
//   独立 30ms 检查：读两个窗口真实 bounds，重叠时沿最短分离轴把其中一只
//   推开（优先推小白；小白被拖着/坠落中则推金毛；都动不了就跳过）。
// ---------------------------------------------------------------------------
function separatePets() {
  if (meet) return;   // 双人互动（演出同框）中允许贴近
  if (!petWin || petWin.isDestroyed() || !pet2Win || pet2Win.isDestroyed()) return;
  // 用权威位置算，不读 getBounds()：tick/tickSecond 每帧已把 roamX/roamY、
  // pet2X/pet2Y 与真实窗口同步，这里直接引用即可（省两次跨进程查询）。
  const g = geometry(), pg = pet2Geometry();
  const a = { x: roamX, y: roamY, width: g.winW, height: g.winH };
  const b = { x: pet2X, y: pet2Y, width: pg.winW, height: pg.winH };
  const m = 6;        // 最小间距（px）
  if (a.x - m >= b.x + b.width || b.x - m >= a.x + a.width ||
      a.y - m >= b.y + b.height || b.y - m >= a.y + a.height) return;  // 没碰上
  const dx = Math.min(b.x + b.width - (a.x - m), a.x + a.width + m - b.x);
  const dy = Math.min(b.y + b.height - (a.y - m), a.y + a.height + m - b.y);
  let nx = 0, ny = 0;
  if (dx <= dy) nx = (b.x + b.width / 2 >= a.x + a.width / 2 ? 1 : -1) * dx;
  else ny = (b.y + b.height / 2 >= a.y + a.height / 2 ? 1 : -1) * dy;
  const bDragging = !!pet2DragTimer || !!pet2Dragged;
  const aDragging = !!dragTimer;
  if (!bDragging && !pet2Falling) {
    const r = pet2Range(pg), vr = pet2VerticalRange(pg);
    pet2X = clamp(pet2X + nx, r.min, r.max);
    pet2Y = clamp(pet2Y + ny, vr.minWindowY, vr.maxWindowY);
    pet2Win.setBounds({ x: Math.round(pet2X), y: Math.round(applyDogShift(2, pet2Y)),
                        width: pg.winW, height: pg.winH });
    if (process.env.GOOSE_DEBUG) console.log('[sep] 推开小白 → ' + Math.round(pet2X) + ',' + Math.round(pet2Y));
  } else if (!aDragging && !falling) {
    moveWindowTo(roamX - nx, roamY - ny);
    if (process.env.GOOSE_DEBUG) console.log('[sep] 推开小金毛 → ' + Math.round(roamX) + ',' + Math.round(roamY));
  }
}

function startRoam() {
  lastTick = Date.now();
  setInterval(tick, 16);
  setInterval(tickSecond, 16);
  setInterval(separatePets, 33);
}

// ---------------------------------------------------------------------------
// 与宠物窗的通信
// ---------------------------------------------------------------------------
function sendPet(msg) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:command', msg);
}

function pushSettings() {
  sendPet({
    type: 'settings',
    scale: Number(settings.scale),
    speedMul: Number(settings.speedMul),
    auto: !!settings.auto,
    follow: !!settings.follow,
    hunger: !!settings.hunger,       // 页面里叫 pet.hungerOn
    bubble: settings.bubble !== false,
    easterEgg: settings.easterEgg !== false,
    actFreq: clamp(Number(settings.actFreq) || 1, RANGES.actFreq[0], RANGES.actFreq[1]),
  });
  pushPet2Settings();                // 小白那一页也要跟着改口
}

// 「穿透 / 追随」这类开关一改，两只狗都要立刻回到「按设置来」的状态：
// 狗身上那点临时状态（hover 开了可点 / 拖动中强制可点）一律作废。
function resetInteractiveForBoth() {
  interactive = false;
  setIgnoreMouse(mouseShouldPassThrough(1));
  pet2Interactive = false;
  setPet2IgnoreMouse(mouseShouldPassThrough(2));
}

function pushGeometry() {
  const g = geometry();
  // 尺寸变了（控制台改「大小」）时窗口的宽高都会变，两个轴都要重新夹一遍。
  // **别把 y 一律拍到底部** —— 狗正走在半空时改大小，它没道理被拽回地面；
  // 夹进新范围、留在原来的高度就行。
  moveWindowTo(roamX, roamY);
  // 上限一起发下去：宠物页自己也有一根「大小」滑杆（浏览器版那个面板），
  // 它得知道现在能调到多大。桌面版不显示滑杆，只拿它做夹取。
  sendPet({ type: 'geom', scale: g.scale, boxW: g.boxW, boxH: g.boxH,
            winW: g.winW, winH: g.winH, maxScale: maxScale() });
  syncPet2Geometry();
}

function snapshotToConsole() {
  const has = consoleWin && !consoleWin.isDestroyed();
  if (!has) return;
  // 两条状态都发同一份快照：控制台页面按自己是哪一只（?pet=2）选着用。
  //   · petState  → 小金毛（亲密度/饱腹/兴致/疲劳/当前动作）
  //   · pet2      → 小白的亲密度/兴致/当前动作
  const snap = Object.assign({}, petState, {
    // 桌上有没有球（控制台那个按钮要靠它显示成「开始」还是「收起」）
    ball: !!ball.on,
    // 踢球小游戏的比分（控制台里也显示一份，球门不在视野里时也能看到）
    ballScore: { left: ballScore[ballSideDog('left')] | 0, right: ballScore[ballSideDog('right')] | 0 },
    ballNames: { left: ballGoalName('left'), right: ballGoalName('right') },
    // 小白那份状态：字段与小金毛完全一致（同一份页面），控制台两边同款画；
    // at = 距今多少毫秒没汇报了（页面卡住/关掉时控制台能看出来）
    pet2: Object.assign({}, pet2State, {
      at: pet2State.snapAt ? Date.now() - pet2State.snapAt : -1,
    }),
    settings: {
      scale: Number(settings.scale), speedMul: Number(settings.speedMul),
      groundOffset: Number(settings.groundOffset),
      rangeTopPct: Number(settings.rangeTopPct),
      rangeBottomPct: Number(settings.rangeBottomPct),
      rangeLeftPct: Number(settings.rangeLeftPct),
      rangeRightPct: Number(settings.rangeRightPct),
      auto: !!settings.auto,
      autoStart: !!settings.autoStart,
      ballSerious: !!settings.ballSerious,
      follow: !!settings.follow, alwaysOnTop: !!settings.alwaysOnTop,
      clickThrough: !!settings.clickThrough, roam: !!settings.roam,
      clickThroughDog: !!settings.clickThroughDog,
      fall: !!settings.fall, hunger: !!settings.hunger,
      bubble: settings.bubble !== false,
      easterEgg: settings.easterEgg !== false,
      actFreq: clamp(Number(settings.actFreq) || 1, RANGES.actFreq[0], RANGES.actFreq[1]),
      food: foodCount(1),         // 小金毛的食材库存（0/1）
      // 「大小」滑杆的两端跟着屏幕走，不写死在 console.html 里
      scaleMin: SCALE_MIN, scaleMax: maxScale(1),
    },
    // 小白那一份 —— 两个控制台各读自己那份（见 console.html 的 IS_PET2）。
    // 共用的只有开机自启动 / 会饿（后者压根不在小白的界面上）。
    settings2: {
      scale: Number(dogSetting(2, 'scale')), speedMul: Number(dogSetting(2, 'speedMul')),
      rangeTopPct: Number(dogSetting(2, 'rangeTopPct')),
      rangeBottomPct: Number(dogSetting(2, 'rangeBottomPct')),
      rangeLeftPct: Number(dogSetting(2, 'rangeLeftPct')),
      rangeRightPct: Number(dogSetting(2, 'rangeRightPct')),
      auto: !!dogSetting(2, 'auto'), follow: !!dogSetting(2, 'follow'),
      alwaysOnTop: !!dogSetting(2, 'alwaysOnTop'),
      clickThrough: !!dogSetting(2, 'clickThrough'),
      clickThroughDog: !!dogSetting(2, 'clickThroughDog'),
      roam: !!dogSetting(2, 'roam'), fall: !!dogSetting(2, 'fall'),
      hunger: !!dogSetting(2, 'hunger'),
      bubble: dogSetting(2, 'bubble') !== false,
      easterEgg: dogSetting(2, 'easterEgg') !== false,
      actFreq: clamp(Number(dogSetting(2, 'actFreq')) || 1,
                     RANGES.actFreq[0], RANGES.actFreq[1]),
      food: foodCount(2),         // 小白的食材库存（0/1，与金毛各一份）
      autoStart: !!settings.autoStart,          // 应用级：两只共用
      ballSerious: !!settings.ballSerious,      // 应用级：踢球模式两只共用
      scaleMin: SCALE_MIN, scaleMax: maxScale(2),
    },
    // V2 新系统数据：状态/关系/空闲/记忆/存档（控制台「V2 系统状态」区）
    v2: v2 ? {
      states: v2.states.snapshot(),
      relationship: (v2.engines.relationship || { snapshot: () => ({ affection: '-', friendship: 0, jealousy: { 1: 0, 2: 0 }, fighting: false }) }).snapshot(),
      idle: (v2.engines.idle || { snapshot: () => ({ mode: 'normal' }) }).snapshot(),
      memory: {
        1: (v2.engines.memory || { stats: () => ({ total: 0 }) }).stats(1),
        2: (v2.engines.memory || { stats: () => ({ total: 0 }) }).stats(2),
      },
      save: { version: v2.config.schemaVersion, savedAt: v2.lastSavedAt },
    } : null,
  });
  consoleWin.webContents.send('console:snapshot', snap);
}

ipcMain.on('pet:ready', () => {
  petReady = true;
  pushGeometry();
  pushSettings();
  setIgnoreMouse(mouseShouldPassThrough(1));
});

let lastConsolePush = 0;
ipcMain.on('pet:report', (_e, snap) => {
  if (!snap) return;
  if (v2) v2.onReport(1, snap);                          // V2：同步影子状态（在删 energy 之前）
  if(snap.state === 'cry' && Date.now() >= comfortCooldownUntil){
    pet1CryAt = Date.now(); scheduleComfort();                           // 小金毛在哭
  }
  // 兼容旧渲染进程的字段，但主进程/控制台都不再保留或显示精力。
  delete snap.energy;
  Object.assign(petState, snap, { snapAt: Date.now() });

  // 拖拽期间姿态会从当前动作切到 pickup；视觉中心随之变化。若仍使用按下瞬间的
  // 窗口偏移，狗就会相对光标滑开。这里把中心变化量实时补进拖拽偏移，让手抓住的
  // 那个狗身位置始终留在光标下。
  if (dragTimer && snap.centerX != null && snap.centerY != null) {
    const nx = Number(snap.centerX), ny = Number(snap.centerY);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (dragCenterX >= 0 && dragCenterY >= 0) {
        dragGrab.dx += nx - dragCenterX;
        dragGrab.dy += ny - dragCenterY;
      }
      dragCenterX = nx;
      dragCenterY = ny;
    }
  }

  // 换算成屏幕速度：舞台单位/秒 → 像素/秒（盒子宽 = VIEW_W 个舞台单位）
  const g = geometry();
  const pxPerUnit = g.boxW / 300;
  const raw = Number(snap.vx) || 0;
  roamVx = settings.roam ? raw * pxPerUnit : 0;

  // 控制台不需要 20Hz，5Hz 足够
  const now = Date.now();
  if (now - lastConsolePush > 200) { lastConsolePush = now; snapshotToConsole(); }
});

ipcMain.on('pet:hover', (_e, on) => {
  if (dogClickThrough(1)) {                 // 连小狗本身也穿透：不响应 hover
    if (interactive) { interactive = false; setIgnoreMouse(true); }
    return;
  }
  if (!settings.clickThrough) return;      // 关掉穿透时窗口始终可点
  // 跟随模式的目的就是让用户直接操作狗身后的窗口/图标：
  // 狗身也不能截断点击，所以 hover 不再把窗口切回可点。
  if (settings.follow) {
    if (interactive) { interactive = false; setIgnoreMouse(true); }
    return;
  }
  if (on === interactive) return;
  interactive = !!on;
  setIgnoreMouse(!interactive);
});

let pendingDragCenterX = -1, pendingDragCenterY = -1;
ipcMain.on('pet:drag-start', (_e, center) => {
  if (dogClickThrough(1)) { setIgnoreMouse(true); return; }
  if (center && Number.isFinite(Number(center.centerX)) && Number.isFinite(Number(center.centerY))) {
    pendingDragCenterX = Number(center.centerX);
    pendingDragCenterY = Number(center.centerY);
  }
  roamSuspended = true;
  roamVx = 0;
  if (settings.clickThrough) { interactive = true; setIgnoreMouse(false); }
});

ipcMain.on('pet:drag-end', () => {
  roamSuspended = roamSuspendFrom();
  interactive = false;
  if (mouseShouldPassThrough(1)) setIgnoreMouse(true);
  settings.x = Math.round(roamX);
  settings.y = Math.round(roamY);
  saveSettings();
});

// 拖动：主进程按光标屏幕坐标搬窗口（页面只负责摆出「被拎起来」的姿态）
let dragTimer = null;
let dragGrab = { dx: 0, dy: 0 };
let dragCenterX = -1, dragCenterY = -1;
ipcMain.on('pet:drag-begin', () => {
  if (!petWin || petWin.isDestroyed()) return;
  // 半路把正在下落的狗接住：停住、速度清零（松手时按新高度重新落）
  falling = false;
  fallVy = 0;
  const c = screen.getCursorScreenPoint();
  const b = petWin.getBounds();
  dragGrab = { dx: c.x - b.x, dy: c.y - b.y };
  const oldCenterX = Number(petState.centerX);
  const oldCenterY = Number(petState.centerY);
  const newCenterX = pendingDragCenterX >= 0 ? pendingDragCenterX : oldCenterX;
  const newCenterY = pendingDragCenterY >= 0 ? pendingDragCenterY : oldCenterY;
  // 拖动开始时会从原动作切到 pickup，中心可能立即改变。先用刚上报的新中心
  // 修正窗口偏移，保证第一帧就不偏。
  if (Number.isFinite(oldCenterX) && oldCenterX >= 0 &&
      Number.isFinite(newCenterX) && newCenterX >= 0) {
    dragGrab.dx += newCenterX - oldCenterX;
  }
  if (Number.isFinite(oldCenterY) && oldCenterY >= 0 &&
      Number.isFinite(newCenterY) && newCenterY >= 0) {
    dragGrab.dy += newCenterY - oldCenterY;
  }
  dragCenterX = Number.isFinite(newCenterX) && newCenterX >= 0 ? newCenterX : -1;
  dragCenterY = Number.isFinite(newCenterY) && newCenterY >= 0 ? newCenterY : -1;
  pendingDragCenterX = -1; pendingDragCenterY = -1;
  roamSuspended = true;
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    roamTargetY = null;                 // 你亲手搬过之后，别马上又自己飘走
    // 位置一律经 moveWindowTo：它同步更新 roamX / roamY，不然 tick 会拿旧值把
    // 窗口拽回去（这是「拖了却弹回原处」那类毛病的根源）。
    moveWindowTo(p.x - dragGrab.dx, p.y - dragGrab.dy);
  }, 16);
});
// 坠落模式的开关有「即时副作用」，所以抽成函数：控制台和托盘两个入口都要做出
// 完全一样的反应，别两处各写一份（迟早改一处忘一处）。
//   · 关掉时如果它正掉着 → 立刻停住，就停在半空
//   · 打开时如果它正悬在半空 → 让它按新规则掉回地面
//     （否则打开这个开关后半天看不出任何变化，只有下次松手才有反应，像是没生效）
function setFallMode(on) {
  const was = !!settings.fall;
  settings.fall = !!on;
  if (!settings.fall) {
    if (falling) {
      falling = false;
      fallVy = 0;
      sendPet({ type: 'stand' });
    }
  } else if (!was && !dragTimer && petWin && !petWin.isDestroyed()) {
    if (petWin.getBounds().y < fallGroundY(1) - 4) {
      roamTargetY = null;
      falling = true;
      fallVy = 0;
      sendPet({ type: 'fall' });
    }
  }
  saveSettings();
}

// 小白版的坠落开关：与上面 setFallMode 完全对称，只是换成它自己的状态与变量。
//   · 关掉时它正掉着 → 立刻停在半空
//   · 打开时它正悬在半空 → 按新规则掉回地面（不然要等下次松手才看得到变化）
function setPet2FallMode(on) {
  const was = !!dogSetting(2, 'fall');
  setDogSetting(2, 'fall', !!on);
  if (!dogSetting(2, 'fall')) {
    if (pet2Falling) {
      pet2Falling = false;
      pet2FallVy = 0;
      sendPet2({ type: 'stand' });         // 与小金毛同名：页面站好
    }
  } else if (!was && !pet2Dragged && pet2Win && !pet2Win.isDestroyed()) {
    const g = pet2Geometry();
    const vr = pet2VerticalRange(g);
    if (pet2Win.getBounds().y < vr.maxWindowY - 4) {
      pet2TargetY = null;
      pet2Falling = true;
      pet2FallVy = 0;
      sendPet2({ type: 'fall' });
    }
  }
  saveSettings();
}

// 松手：窗口该掉就掉、该站就站。抽成函数是为了自检能走**完全相同**的那条路
// （不然验的是一段只在测试里跑的分支，等于没验）。
function releaseDrag() {
  if (!petWin || petWin.isDestroyed()) return;
  const g = geometry();
  const b = petWin.getBounds();
  const groundY = fallGroundY(1);
  roamTargetY = null;

  const canFall = !!settings.fall;

  if (canFall && b.y < groundY - 4) {
    // 还在半空 → 让它真的**掉下来**（tick 里的自由落体分支），页面同时切掉落姿态。
    // 以前这里是直接 setBounds 拍到地面线，看起来像瞬移，完全没有
    // 「松手 → 下落 → 落地」这一串。
    // 「落到最底部」是有意的：竖直漫游不施重力，只有这里会掉，所以这也成了
    // 唯一一条把它送回地面的路（用户明确要的就是这个手感）。
    falling = true;
    fallVy = 0;
    sendPet({ type: 'fall' });
  } else {
    // 贴着地线松的手（拖动只改了 x）：摆正就行，不必演一次下落。
    // 坠落模式关掉时连「摆正」也免了 —— 停在半空正是它该有的样子。
    if (canFall && b.y !== groundY) moveWindowTo(b.x, groundY);
    sendPet({ type: 'stand' });
  }
}

ipcMain.on('pet:drag-stop', () => {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  dragCenterX = -1; dragCenterY = -1;
  roamSuspended = roamSuspendFrom();
  settings.x = Math.round(roamX);
  settings.y = Math.round(roamY);
  saveSettings();
  releaseDrag();
});

ipcMain.on('goose:act', (_e, act) => {       // 捣蛋模块触发官方动作
  if (!ACTIONS.includes(act)) return;
  // 按来源窗口分发：小金毛的走 pet:command，小白的走 pet2:command
  const toPup = pet2Win && !pet2Win.isDestroyed() && _e.sender === pet2Win.webContents;
  (toPup ? sendPet2 : sendPet)({ type: 'act', act });
});

ipcMain.on('pet:action', (_e, act) => {          // 页面里自己点的（摸摸头/双击）
  if (act === 'pet') petState.happiness = petState.happiness;
  if (v2) v2.recordInteract(1);                  // V2：互动重置无聊度
  snapshotToConsole();
});

// ---------------------------------------------------------------------------
// 与控制台窗的通信
// ---------------------------------------------------------------------------
// 控制台每秒轮询一次快照。**这里只回快照，不要再 pushSettings()** ——
// pushSettings 是「设置变了，通知宠物」用的；挂在轮询上就等于每秒把设置文件里
// 那份重新灌给宠物一次，任何临时改动（比如自检里临时关掉自动活动）都会被它
// 一秒一次地覆盖回去，看上去像设置没生效。
ipcMain.on('console:request-snapshot', () => { snapshotToConsole(); });

ipcMain.on('console:act', (_e, act) => {
  if (!ACTIONS.includes(act)) return;
  if (v2 && act !== 'deleteFile') v2.recordInteract(1);   // V2：控制台动作=互动
  if (act === 'deleteFile') { deleteFilesFor(1); return; }
  if (act === 'ballGame') { ball.on ? stopBallGame() : startBallGame(); return; }  // 小游戏：把球丢到桌上 / 收回来
  if (act === 'giveFood') { giveFood(1); return; }   // 给食材（做饭的前置）
  if (act === 'cook') { cookNow(1); return; }        // 做饭：要食材、两只一起吃
  if (MEET_KINDS[act]) { startMeet(act); return; }   // 两只狗互动：主进程编排
  sendPet({ type: 'act', act });
  if (act === 'home') {                        // 「叫到身边」= 搬回屏幕中偏左
    const g = geometry(); const wa = workArea();
    roamTargetY = null;
    moveWindowTo(wa.x + Math.round(wa.width * 0.30), screenFloorWindowY(g, FOOT));
    settings.x = Math.round(roamX); settings.y = Math.round(roamY); saveSettings();
  }
  snapshotToConsole();
});

// 控制台共用同一段设置逻辑，所以这里抽成函数、挂到两条通道上，别再抄第二遍。
/* 控制台按当前标签各改各的 —— 这里带一个 target：
     1 = 小金毛（顶层那批键）、2 = 小白（settings.pet2 里同名的一批）。
   共用一份的只有开机自启动；「会饿」只属于小金毛，小白的界面上根本没有它。 */
function applyConsoleSet(msg, target) {
  const t = target === 2 ? 2 : 1;
  const is2 = (t === 2);
  if (!msg || !msg.key) return;
  const k = msg.key;
  const v = msg.value;
  if (process.env.PET_DEBUG) console.log('[pet] console:set ' + JSON.stringify(msg));

  // 这只狗设置变了 → 把新值推给它的窗口（几何 + 行为开关）
  const push = () => {
    if (is2) { syncPet2Geometry(); pushPet2Settings(); }
    else { pushGeometry(); pushSettings(); }
  };
  const dog = (key) => dogSetting(t, key);

  switch (k) {
    case 'scale': {
      // 上限是算出来的（maxScale），控制台滑杆和这里都用同一份，免得绕过去
      const n = Number(v);
      setDogSetting(t, 'scale',
        clamp(Number.isFinite(n) ? n : DEFAULTS.scale, SCALE_MIN, maxScale(t)));
      push();
      if(t === 1) syncBallSize();      // 球的大小跟着狗走
      break;
    }
    case 'speedMul':
      setDogSetting(t, 'speedMul',
        clamp(Number(v), RANGES.speedMul[0], RANGES.speedMul[1]));
      push();
      break;
    case 'groundOffset':
      // 早期版本的站立高度，只对小金毛有历史意义（小白没有这个概念）
      settings.groundOffset = Number(v);
      pushGeometry(); pushSettings();
      break;
    case 'rangeLeftPct': case 'rangeRightPct': {
      const rr2 = RANGES[k];
      const n2 = Number(v);
      setDogSetting(t, k, clamp(Number.isFinite(n2) ? n2 : DEFAULTS[k], rr2[0], rr2[1]));
      // 左右边界至少留 1% 间隔（同上下）：改左边就把右边顶开，反之亦然
      if (Number(dog('rangeRightPct')) - Number(dog('rangeLeftPct')) < 1) {
        if (k === 'rangeLeftPct') {
          setDogSetting(t, 'rangeRightPct',
            Math.min(RANGES.rangeRightPct[1], Number(dog('rangeLeftPct')) + 1));
        } else {
          setDogSetting(t, 'rangeLeftPct',
            Math.max(RANGES.rangeLeftPct[0], Number(dog('rangeRightPct')) - 1));
        }
      }
      push();
      break;
    }
    case 'rangeTopPct': case 'rangeBottomPct': {
      const rr = RANGES[k];
      const n = Number(v);
      setDogSetting(t, k, clamp(Number.isFinite(n) ? n : DEFAULTS[k], rr[0], rr[1]));
      // 上下边界至少留 1% 间隔：改上面就把下面顶下去，反之亦然
      if (Number(dog('rangeBottomPct')) - Number(dog('rangeTopPct')) < 1) {
        if (k === 'rangeTopPct') {
          setDogSetting(t, 'rangeBottomPct',
            Math.min(RANGES.rangeBottomPct[1], Number(dog('rangeTopPct')) + 1));
        } else {
          setDogSetting(t, 'rangeTopPct',
            Math.max(RANGES.rangeTopPct[0], Number(dog('rangeBottomPct')) - 1));
        }
      }
      invalidateMaxScale(t);                    // 活动区变窄 → 这只狗的体型上限也变
      setDogSetting(t, 'scale',
        clamp(Number(dog('scale')) || DEFAULTS.scale, SCALE_MIN, maxScale(t)));
      push();
      break;
    }
    case 'auto': case 'roam':
      setDogSetting(t, k, !!v);
      push();
      break;
    case 'hunger':
      setDogSetting(t, 'hunger', !!v);          // 两只各有会饿开关
      push();
      break;
    case 'bubble':
      // 对话气泡开关（每只一份）：关掉之后页面完全不说话
      setDogSetting(t, 'bubble', !!v);
      push();
      break;
    case 'easterEgg':
      // 连续摸头彩蛋开关（每只一份）
      setDogSetting(t, 'easterEgg', !!v);
      push();
      break;
    case 'actFreq': {
      // 动作切换频率倍率（每只一份）：>1 = 每个动作停留更短、换得更勤
      const n = Number(v);
      setDogSetting(t, 'actFreq',
        clamp(Number.isFinite(n) ? n : 1, RANGES.actFreq[0], RANGES.actFreq[1]));
      push();
      break;
    }
    case 'follow':
      setDogSetting(t, 'follow', !!v);
      if (dog('follow') && mouseShouldPassThrough(t)) {
        if (is2) { pet2Interactive = false; setPet2IgnoreMouse(true); }
        else { interactive = false; setIgnoreMouse(true); }
      }
      push();
      break;
    case 'fall':
      if (is2) setPet2FallMode(!!v);
      else setFallMode(!!v);
      break;
    case 'alwaysOnTop':
      setDogSetting(t, k, !!v);
      applyAlwaysOnTop();
      break;
    case 'autoStart':
      // 应用级：整台机器就一个自启动项，两个控制台里显示的是同一个值
      settings.autoStart = !!v;
      applyAutoStart();
      break;
    case 'ballSerious':
      // 应用级：踢球模式（娱乐赛 / 认真赛），两只狗共用
      settings.ballSerious = !!v;
      pushGoalScore();          // 球门上那行小字要跟着改
      break;
    case 'clickThrough':
      setDogSetting(t, k, !!v);
      if (is2) { pet2Interactive = false; setPet2IgnoreMouse(mouseShouldPassThrough(2)); }
      else { interactive = false; setIgnoreMouse(mouseShouldPassThrough(1)); }
      break;
    case 'clickThroughDog':
      setDogSetting(t, k, !!v);
      if (is2) { pet2Interactive = false; setPet2IgnoreMouse(mouseShouldPassThrough(2)); }
      else { interactive = false; setIgnoreMouse(mouseShouldPassThrough(1)); }
      break;
    default: return;
  }
  saveSettings();
  snapshotToConsole();
}

ipcMain.on('console:set', (_e, msg) => applyConsoleSet(msg, 1));
ipcMain.on('console2:set', (_e, msg) => applyConsoleSet(msg, 2));

ipcMain.on('console:open', () => { settings.consoleTarget = 1; saveSettings(); openConsoleFor(1); });
ipcMain.on('console:tab', (_e, target) => {
  settings.consoleTarget = target === 2 ? 2 : 1;
  settings.console2Open = target === 2;
  saveSettings();
});

// 小白控制台的按钮：与小金毛走同一段逻辑（同一份页面、同一批动作）。
// 「叫到身边」要真的把它的窗口搬到屏幕中偏左，不能只发个动作就算了。
ipcMain.on('console2:act', (_e, act) => {
  if (!PET2_ACTIONS.includes(act)) return;
  if (v2 && act !== 'deleteFile') v2.recordInteract(2);   // V2：控制台动作=互动
  if (act === 'deleteFile') { deleteFilesFor(2); return; }
  if (act === 'ballGame') { ball.on ? stopBallGame() : startBallGame(); return; }  // 小游戏：两只狗都能玩
  if (act === 'giveFood') { giveFood(2); return; }
  if (act === 'cook') { cookNow(2); return; }
  if (MEET_KINDS[act]) { startMeet(act); return; }   // 两只狗互动：主进程编排
  sendPet2({ type: 'act', act });
  if (act === 'home') {
    const g = pet2Geometry(); const wa = workArea();
    pet2TargetY = null;
    const r = pet2Range(g), vr = pet2VerticalRange(g);
    pet2X = clamp(wa.x + Math.round(wa.width * 0.30) - g.padX, r.min, r.max);
    // 同上：落到屏幕底边（再夹进它自己的活动范围里）
    pet2Y = clamp(screenFloorWindowY(g, PET2_FOOT), vr.minWindowY, vr.maxWindowY);
    if (pet2Win && !pet2Win.isDestroyed()) {
      pet2Win.setBounds({ x: Math.round(pet2X), y: Math.round(pet2Y),
                          width: g.winW, height: g.winH });
    }
    settings.pet2.x = Math.round(pet2X); settings.pet2.y = Math.round(pet2Y);
    saveSettings();
  }
  snapshotToConsole();
});

// 桌面小球：鼠标按住/松开/右键收起（球那扇窗只负责把这几件事报上来）
ipcMain.on('ball:grab', () => {
  if(!ball.on || ball.held) return;
  ball.grabAt = Date.now();
  // 新的一轮「拿着球逗狗」：两只狗的求球状态清空，所以每次拿起都会重新求一次
  [1, 2].forEach((t) => {
    if(ballDogs[t]){ ballDogs[t].askDone = false; ballDogs[t].askUntil = 0; }
  });
  // 玩家把球拿起来了 —— 让离球最近的那只狗说句话（另一只这时候只会看着）
  {
    const cands = [1, 2].filter((t) => {
      const win = t === 2 ? pet2Win : petWin;
      return win && !win.isDestroyed();
    });
    if(cands.length){
      let best = cands[0], bd = Infinity;
      cands.forEach((t) => {
        const c = meetDogCenter(t);
        const d = Math.hypot(ball.x - c.x, ball.y - c.y);
        if(d < bd){ bd = d; best = t; }
      });
      ballSay(best, 'held', 1800);
    }
  }
  const c = screen.getCursorScreenPoint();
  ball.grabbed = true;
  ball.grabDX = c.x - ball.x;
  ball.grabDY = c.y - ball.y;
  ball.vx = 0; ball.vy = 0;
  ball.samples = [{ x: ball.x, y: ball.y, t: Date.now() }];
});

ipcMain.on('ball:release', () => {
  if(!ball.on || !ball.grabbed) return;
  ball.grabbed = false;
  const s = ballScale();
  const sm = ball.samples;
  let vx = 0, vy = 0;
  if(sm.length >= 2){
    const now = Date.now();
    let i = 0;
    while(i < sm.length - 1 && now - sm[i].t > 110) i++;
    const a = sm[i], b = sm[sm.length - 1];
    const dt = Math.max(0.016, (b.t - a.t) / 1000);
    vx = (b.x - a.x) / dt;
    vy = (b.y - a.y) / dt;
    const sp = Math.hypot(vx, vy), cap = BALL_MAX_THROW * s;
    if(sp > cap){ vx = vx / sp * cap; vy = vy / sp * cap; }
    if(sp < 90 * s){ vx = 0; vy = 0; }        // 轻轻放下 = 让它自己掉
  }
  ball.vx = vx; ball.vy = vy;
  ball.samples = [];
  if(vx || vy) ballResetChaseSays();     // 球飞出去了 → 追球台词重新开闸
});

ipcMain.on('ball:pickup', () => stopBallGame());

// 球门那两页刚加载完会来要一次比分
ipcMain.on('goal:request', (e) => {
  e.sender.send('goal:state', { left: ballScore[ballSideDog('left')] | 0,
                                right: ballScore[ballSideDog('right')] | 0,
                                serious: !!settings.ballSerious });
});

ipcMain.on('app:quit', () => {
  if (petWin && !petWin.isDestroyed()) {
    settings.x = Math.round(roamX);
    settings.y = Math.round(roamY);
  }
  try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); } catch (e) {}
  farewellThenQuit();
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  build: BUILD_STAMP,
  electron: process.versions.electron,
  settingsFile: SETTINGS_FILE(),
}));

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function createTray() {
  let img = nativeImage.createFromPath(ICON_PATH);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  // 表情包彩色图标：明确告诉系统不按模板反色，深浅色菜单栏都显示原色。
  if (process.platform === 'darwin') img.setTemplateImage(false);
  tray = new Tray(img);
  tray.setToolTip('线条小狗桌宠 · 单击打开控制台');
  // **macOS 上不要 tray.setContextMenu()**：一旦挂上上下文菜单，系统会把单击
  // 托盘图标这个动作拿去掉菜单，'click' 事件根本不发 —— 于是「单击打开控制台」
  // 这条路在 macOS 上是死的（README 一直这么写，代码也一直这么以为）。
  // 现在自己管：单击开控制台，右键弹菜单（popUpContextMenu 只在 darwin 可用）。
  // Windows / Linux 没有等价物，仍旧挂 setContextMenu。
  refreshTrayMenu();
  tray.on('click', () => openConsole());
  if (process.platform === 'darwin') {
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu));
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  trayMenu = Menu.buildFromTemplate([
    { label: '小金毛控制台…', click: () => openConsole() },
    { label: '小白控制台…', click: () => openConsole2() },
    { type: 'separator' },
    // 托盘这一栏是「两只一起改」的快捷开关（控制台里才是各改各的）；
    // 勾选状态显示的是小金毛那一份。
    { label: '自动活动（两只）', type: 'checkbox', checked: !!settings.auto,
      click: (i) => { setBothDogs('auto', i.checked); sendPet({ type: 'settings', auto: i.checked });
                      pushPet2Settings(); saveSettings(); refreshTrayMenu(); } },
    { label: '到处走走（两只）', type: 'checkbox', checked: !!settings.roam,
      click: (i) => { setBothDogs('roam', i.checked); pushPet2Settings();
                      saveSettings(); refreshTrayMenu(); } },
    { label: '跟随鼠标（两只）', type: 'checkbox', checked: !!settings.follow,
      click: (i) => {
        setBothDogs('follow', i.checked);
        if (settings.follow && mouseShouldPassThrough(1)) {
          interactive = false; setIgnoreMouse(true);
          pet2Interactive = false; setPet2IgnoreMouse(true);
        }
        sendPet({ type: 'settings', follow: i.checked });
        pushPet2Settings();
        saveSettings(); refreshTrayMenu();
      } },
    { label: '坠落模式（两只）', type: 'checkbox', checked: !!settings.fall,
      click: (i) => { setFallMode(i.checked); setPet2FallMode(i.checked); refreshTrayMenu(); } },
    { label: '会饿（两只）', type: 'checkbox', checked: !!settings.hunger,
      click: (i) => { setBothDogs('hunger', i.checked); sendPet({ type: 'settings', hunger: i.checked });
                      pushPet2Settings(); saveSettings(); refreshTrayMenu(); } },
    { type: 'separator' },
    { label: '总是置顶（两只）', type: 'checkbox', checked: !!settings.alwaysOnTop,
      click: (i) => { setBothDogs('alwaysOnTop', i.checked); applyAlwaysOnTop();
                      saveSettings(); refreshTrayMenu(); } },
    { label: '开机自启动', type: 'checkbox', checked: !!settings.autoStart,
      click: (i) => { settings.autoStart = i.checked; applyAutoStart(); saveSettings(); refreshTrayMenu(); } },
    { label: '空白处点击穿透（两只）', type: 'checkbox', checked: !!settings.clickThrough,
      click: (i) => { setBothDogs('clickThrough', i.checked); resetInteractiveForBoth();
                      saveSettings(); refreshTrayMenu(); } },
    { label: '鼠标穿透小狗点击（两只）', type: 'checkbox', checked: !!settings.clickThroughDog,
      click: (i) => { setBothDogs('clickThroughDog', i.checked); resetInteractiveForBoth();
                      saveSettings(); refreshTrayMenu(); } },
    { type: 'separator' },
    { label: '让它回到身边', click: () => {
        const g = geometry(); const wa = workArea();
        roamTargetY = null;
        moveWindowTo(wa.x + Math.round(wa.width * 0.30), yBottom(g));
      } },
    { type: 'separator' },
    ...goose.trayItems(),
    { label: '退出', click: () => { ipcMain.emit('app:quit'); } },
  ]);
  // darwin 上菜单是自己 popUp 出来的（见 createTray），挂上去反而会把单击吃掉
  if (process.platform !== 'darwin') tray.setContextMenu(trayMenu);
}

// ---------------------------------------------------------------------------
// 自检：--shot-dir=<目录> 时把两个窗口各截一张图再退出
// （用 webContents.capturePage，不需要系统的录屏权限）
// ---------------------------------------------------------------------------
function selfTest(dirRaw) {
  const dir = dirRaw === true ? path.join(app.getPath('userData'), 'shots') : dirRaw;
  fs.mkdirSync(dir, { recursive: true });
  const shots = [];
  const shoot = (win, name) => new Promise((res) => {
    if (!win || win.isDestroyed()) return res();
    win.webContents.capturePage().then((img) => {
      const p = path.join(dir, name + '.png');
      fs.writeFileSync(p, img.toPNG());
      shots.push(p);
      res();
    }).catch(() => res());
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  setTimeout(async () => {
    // 等页面把 pet:ready 发过来再动手。页面里有 1.2MB 内联骨架，脚本要 DOM 解析
    // 完才跑；抢在它之前发指令是**竞态** —— pet:ready 触发的 pushSettings() 会把
    // 刚设好的值又覆盖回设置文件里的那份（这边「关掉自动活动」就这么被吃掉了，
    // 量出来只有真实速度的六成）。
    for (let i = 0; i < 200 && !petReady; i++) await sleep(50);
    await sleep(400);

    // 桌宠最核心的行为是「窗口真的在屏幕上位移」，所以这里要量准。
    // **先关掉自动活动**：开着的话 walk 的 dur 一到（1.4~4s）就会被自动调度拽去
    // 做别的动作，量出来只有真实速度的一部分 —— 那种数字无法判断漫游引擎对不对。
    // 关掉之后它会一直走，位移除以时间就是真实速度。
    const autoWas = !!settings.auto;
    settings.auto = false;
    pushSettings();
    await sleep(150);
    sendPet({ type: 'act', act: 'walk' });

    const t0 = Date.now();
    const xs = [];
    const timeline = [];
    let bumps = 0, lastX = null;
    let walkPx = 0, walkMs = 0, prev = null;
    for (let i = 0; i < 44; i++) {
      await sleep(120);
      if (!petWin || petWin.isDestroyed()) break;
      const b = petWin.getBounds();
      xs.push(b.x);
      const r = roamRange(geometry());
      if (lastX !== null && b.x !== lastX && (b.x <= r.min || b.x >= r.max)) bumps++;
      // 只在「上一拍和这一拍都在走」的区间里累计位移与时长。
      // 直接拿「首尾位移 ÷ 总时长」是不行的：中途被拖一下、或者自动活动切走了
      // 几秒，分母照跑而分子没了，量出来会只有真实速度的三成（实测 0.33）。
      const st = petState.state;
      if (prev && prev.s === 'walk' && st === 'walk') {
        walkPx += Math.abs(b.x - prev.x);
        walkMs += 120;
      }
      prev = { s: st, x: b.x };
      lastX = b.x;
      if (!timeline.length || timeline[timeline.length - 1].s !== st) {
        timeline.push({ s: st, at: Number(((Date.now() - t0) / 1000).toFixed(1)) });
      }
    }
    const secs = (Date.now() - t0) / 1000;

    settings.auto = autoWas;                        // 恢复原设置再截图
    pushSettings();
    await sleep(300);
    await shoot(petWin, 'app-pet');

    consoleWin = null;
    createConsoleWindow();
    await sleep(1500);
    await shoot(consoleWin, 'app-console');
    if (consoleWin && !consoleWin.isDestroyed()) {
      consoleWin.webContents.send('console:select-pet', 2);
      await sleep(600);
      await shoot(consoleWin, 'app-console2');
    }

    // 第二只小狗也用应用自己的 capturePage 留一张验收图，不依赖系统录屏权限。
    if(pet2Win && !pet2Win.isDestroyed()){
      await sleep(500);
      await shoot(pet2Win, 'app-pet2');
    }

    // ---- 小白的「基础功能」验收 ----
    // 全程走真实链路、只看两边的公开状态，不偷看页面内部变量：
    //   控制台按钮 → 主进程白名单 → 页面自己处理（台词/爱心/亲密度）→ 页面回报
    //   → 主进程的 pet2State（控制台读的就是它）。
    const p2 = { intimacyBefore: Number(pet2State.happiness) };
    if(pet2Win && !pet2Win.isDestroyed()){
      // ① 从控制台那条路摸一下头
      ipcMain.emit('console2:act', null, 'pet');
      await sleep(600);
      p2.intimacyAfter = Number(pet2State.happiness);
      p2.intimacyGain = Number((p2.intimacyAfter - p2.intimacyBefore).toFixed(2));
      p2.bubble = await pet2Win.webContents.executeJavaScript(
        '(() => { const b = document.getElementById("bubble");'
        + ' return { text: b.textContent, shown: b.classList.contains("show") }; })()');
      p2.hearts = await pet2Win.webContents.executeJavaScript(
        'document.querySelectorAll("#fx .fx").length');
      await shoot(pet2Win, 'app-pet2-pet');   // 带着气泡 + 爱心的一帧

      // ② 光标停在狗身上 → 这扇窗该变成可点；移开 → 回到穿透
      //   （穿透开关默认开着，见设置里的 clickThrough）
      await pet2Win.webContents.executeJavaScript(
        '(() => { const r = document.getElementById("petPos").getBoundingClientRect();'
        + ' window.dispatchEvent(new MouseEvent("mousemove",'
        + '   { clientX: r.left + r.width/2, clientY: r.top + r.height/2 })); })()');
      await sleep(250);
      p2.interactiveOnDog = !!pet2Interactive;
      await pet2Win.webContents.executeJavaScript(
        'window.dispatchEvent(new MouseEvent("mousemove", { clientX: 3, clientY: 3 }))');
      await sleep(250);
      p2.interactiveOffDog = !!pet2Interactive;

      // ③ 静止站立要有微动（呼吸 + 慢摆）—— 不能是一张死图。
      //   先让它「坐下」再关自动活动：sit 分支的呼吸/慢摆由 sin(t) 驱动必会变化，
      //   排除它恰好停在 cry/eat 等演出态（那些态本身播帧动画，transform 恒定是设计）。
      //   关掉自动活动后它停在 sit，再隔 900ms 连续采样 3 次比对 transform：
      //   只认「同一只狗、同一姿势，但这两个时刻的变换不一样」，不看具体数值。
      ipcMain.emit('console2:act', null, 'sit');
      await sleep(800);
      const autoWas2 = !!dogSetting(2, 'auto');
      setDogSetting(2, 'auto', false);
      pushPet2Settings();
      await sleep(700);
      //   **量 rotate / scale 这两个独立变换属性**，不是 transform ——
      //   小白的微动刻意走独立属性（两条动画各管一个，互不覆盖），
      //   getComputedStyle(...).transform 在这两条动画下是恒定的。
      await pet2Win.webContents.executeJavaScript(
        'window.__p2s = []; window.__rafN = 0; window.__rafOn = true;'
        + ' (function(){ function f(){ if(!window.__rafOn) return;'
        + '   window.__rafN++; requestAnimationFrame(f); } requestAnimationFrame(f);'
        + '   const a = getComputedStyle(document.getElementById("petAnim")).transform;'
        + '   const c = getComputedStyle(document.getElementById("pupCanvas")).transform;'
        + '   window.__p2s.push(a + "|" + c); })()');
      await sleep(900);
      await pet2Win.webContents.executeJavaScript(
        '(function(){'
        + '   const a = getComputedStyle(document.getElementById("petAnim")).transform;'
        + '   const c = getComputedStyle(document.getElementById("pupCanvas")).transform;'
        + '   window.__p2s.push(a + "|" + c); })()');
      await sleep(900);
      await pet2Win.webContents.executeJavaScript(
        '(function(){'
        + '   const a = getComputedStyle(document.getElementById("petAnim")).transform;'
        + '   const c = getComputedStyle(document.getElementById("pupCanvas")).transform;'
        + '   window.__p2s.push(a + "|" + c); })()');
      await sleep(900);
      p2.idleMotion = await pet2Win.webContents.executeJavaScript(
        '(() => { const set = new Set(window.__p2s);'
        + ' window.__rafOn = false;'
        + ' return { changed: set.size > 1, samples: window.__p2s.length, rafN: window.__rafN }; })()');
      setDogSetting(2, 'auto', autoWas2);
      pushPet2Settings();

      // ④ 长按 0.5 秒 → 拿起（窗口跟着光标走）；松手 → 站好
      const posBefore = pet2Win.getBounds();
      await pet2Win.webContents.executeJavaScript(
        '(() => { const d = document.getElementById("petPos");'
        + ' const r = d.getBoundingClientRect();'
        + ' d.dispatchEvent(new PointerEvent("pointerdown", { button:0, pointerId:1, bubbles:true,'
        + '   clientX: r.left + r.width/2, clientY: r.top + r.height/2 })); })()');
      await sleep(900);                       // 长按门槛是 500ms
      p2.dragStarted = !!pet2Dragged;
      await pet2Win.webContents.executeJavaScript(
        'document.getElementById("petPos").dispatchEvent('
        + 'new PointerEvent("pointerup", { button:0, pointerId:1, bubbles:true }))');
      await sleep(300);
      p2.dragEnded = !pet2Dragged;
      // 自检别把小白留在屏幕另一头：放回它原来的位置（设置里那份也一起还原，
      // 否则下次开机会从「自检拖到的地方」开始）
      pet2X = posBefore.x; pet2Y = posBefore.y;
      syncPet2Geometry();
      settings.pet2.x = Math.round(pet2X);
      settings.pet2.y = Math.round(pet2Y);
    }

    // ---- 2D 漫游验收 ----
    // 用户要的是「满桌面走」，不是贴着屏幕上沿/下沿那条线走。这里量两件事：
    //   hold  —— 把它放到屏幕中间高度，静置时它会不会被重力拽回底部（应该不会）
    //   climb —— 让它往上走，竖直方向是不是真的在动（把目标高度钉死，免得随机）
    settings.auto = false;
    pushSettings();
    const g2 = geometry();
    const top2 = yTop(g2), bot2 = yBottom(g2);
    const midY = Math.round((top2 + bot2) / 2);
    sendPet({ type: 'act', act: 'sit' });     // 先让它别走：静置量的是「会不会被拽下去」
    await sleep(200);
    moveWindowTo(roamX, midY);
    await sleep(600);
    const holdY = petWin.getBounds().y;
    sendPet({ type: 'act', act: 'walk' });
    await sleep(300);
    roamTargetY = top2 + 10;                 // 钉死目标：往上走
    nextYPick = Date.now() + 60000;
    const y0 = petWin.getBounds().y;
    await sleep(2500);
    const y1 = petWin.getBounds().y;

    // ---- 下落验收：抬到半空再松手，量它是不是真的掉回地面线 ----
    // 走 releaseDrag()，也就是真实「松手」那条路（不是另写一段只给测试用的分支，
    // 那样验的是一段线上根本不跑的东西）。
    settings.auto = false;                 // 别让自动活动中途把状态抢走
    pushSettings();
    await sleep(120);
    const gf = geometry();
    const groundYf = yBottom(gf);
    const lift = 240;
    // 「拖到半空」这一步要真的等价于拖动：真实的拖动就是靠 dragTimer 每 16ms
    // setBounds 实现的，而 tick 在没有 dragTimer 时不会自己往下掉。
    // 所以先挂一个空转的 dragTimer 把 tick 挡开，再把窗口抬上去。
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = setInterval(function () {}, 16);
    moveWindowTo(roamX, groundYf - lift);
    await sleep(150);
    const liftedY = petWin.getBounds().y;
    // 松手：顺序与 pet:drag-stop 完全一致（先撤拖动的定时器，再交给 releaseDrag）
    clearInterval(dragTimer);
    dragTimer = null;

    const tf = Date.now();
    releaseDrag();
    const fallStates = [];
    let landedMs = null, midShot = false;
    for (let i = 0; i < 60; i++) {
      await sleep(40);
      if (!petWin || petWin.isDestroyed()) break;
      const y = petWin.getBounds().y;
      const s = petState.state;
      if (!fallStates.length || fallStates[fallStates.length - 1].s !== s) {
        fallStates.push({ s: s, y: y, at: Number(((Date.now() - tf) / 1000).toFixed(2)) });
      }
      if (landedMs === null && y >= groundYf - 1) landedMs = Date.now() - tf;
      if (!midShot && y > groundYf - lift * 0.5 && y < groundYf - 12) {
        midShot = true;
        await shoot(petWin, 'app-fall');
      }
    }
    // ---- 「坠落模式关掉」验收：半空松手应该**停在原地** ----
    // 守的是新开关真的接进了「松手」那条路，而不是只在设置文件里躺着一个布尔。
    settings.fall = false;
    const g3 = geometry();
    const groundY3 = yBottom(g3);
    const lift3 = Math.min(200, Math.round((groundY3 - yTop(g3)) / 2));
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = setInterval(function () {}, 16);
    moveWindowTo(roamX, groundY3 - lift3);
    await sleep(150);
    const heldY = petWin.getBounds().y;
    clearInterval(dragTimer);
    dragTimer = null;
    releaseDrag();                              // 与真实松手完全同一条路
    await sleep(900);
    const afterY = petWin.getBounds().y;
    const noFallState = petState.state;
    settings.fall = true;                       // 恢复默认，别把设置留在测试态

    // ---- 「会饿」关掉验收：把饥饿值顶到 78 再关掉，应该立刻回到 0 ----
    // （先顶高才说明问题：本来就在 0 附近的话，「一直是 0」什么也证明不了）
    settings.hunger = true;
    pushSettings();
    await sleep(150);
    sendPet({ type: 'act', act: 'hungry' });
    await sleep(400);
    const hungHigh = Number(petState.hunger);
    settings.hunger = false;
    pushSettings();
    await sleep(900);
    const hungOff = Number(petState.hunger);
    settings.hunger = true;
    pushSettings();

    settings.auto = autoWas;
    pushSettings();

    const g = geometry();
    const r = roamRange(g);
    const lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
    const expected = 82 * (g.boxW / 300);            // CFG.walk=82 舞台单位/秒 → 像素/秒
    console.log('SELFTEST_SHOTS=' + JSON.stringify(shots));
    console.log('SELFTEST_PET_BOUNDS=' + JSON.stringify(petWin.getBounds()));
    console.log('SELFTEST_FALL=' + JSON.stringify({
      liftedPx: liftedY === null ? null : groundYf - liftedY,
      landedMs: landedMs,
      endY: petWin.getBounds().y,
      groundY: groundYf,
      states: fallStates,
    }));
    console.log('SELFTEST_2D=' + JSON.stringify({
      top: top2, mid: midY, bottom: bot2,
      holdY: holdY,
      pushedBackToBottom: Math.abs(holdY - bot2) < 4 && Math.abs(midY - bot2) > 40,
      climbFrom: y0, climbTo: y1,
      climbedPx: y0 - y1,
    }));
    console.log('SELFTEST_NOFALL=' + JSON.stringify({
      liftedPx: groundY3 - heldY,
      heldY: heldY,
      afterY: afterY,
      groundY: groundY3,
      driftPx: afterY - heldY,
      state: noFallState,
      // 停在原地 = 松手前后几乎没动，而且明显没在地面上
      stayedUp: Math.abs(afterY - heldY) <= 2 && heldY < groundY3 - 20,
    }));
    console.log('SELFTEST_HUNGER=' + JSON.stringify({
      afterHungryBtn: hungHigh,
      hungerOff: hungOff,
      fullWhenOff: hungOff === 0,
    }));
    console.log('SELFTEST_PET2=' + JSON.stringify(p2));
    console.log('SELFTEST_SCALE=' + JSON.stringify({
      min: SCALE_MIN, max: maxScale(), hardMax: SCALE_MAX_HARD,
      winHAtMax: winHeightFor(maxScale()),
      workAreaH: workArea().height,
    }));
    // 把自检期间临时改过的设置（fall / auto / 小白的位置）写回，别把测试态留在
    // 用户的设置文件里。**必须同步写**：saveSettings() 是 250ms 的防抖，
    // 而下一行就是 app.exit(0) —— 定时器根本来不及跑，于是测试态照样留在盘上。
    try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); } catch (e) {}
    console.log('SELFTEST_ROAM=' + JSON.stringify({
      samples: xs.length,
      seconds: Number(secs.toFixed(2)),
      travelled: hi - lo,
      // 只在「确实在走」的时间窗上算的速度：这是判断漫游引擎对不对的那个数。
      walkMs: walkMs,
      walkPx: walkPx,
      pxPerSec: walkMs ? Number((walkPx / (walkMs / 1000)).toFixed(1)) : null,
      expectPxPerSec: Number(expected.toFixed(1)),
      ratio: walkMs ? Number(((walkPx / (walkMs / 1000)) / expected).toFixed(2)) : null,
      // 首尾位移 ÷ 总时长：被人拖一下/被自动活动切走就会偏低，仅作参考
      naivePxPerSec: Number(((hi - lo) / secs).toFixed(1)),
      range: [Math.round(r.min), Math.round(r.max)],
      state: petState.state,
      rendererAuto: petState.auto,
      mainAuto: !!settings.auto,
      timeline: timeline,
      bumps: bumps,
    }));
    app.exit(0);
  }, 1800);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!deleteFilesFromArgv(argv)) openConsole();
  });

  // macOS 的「再打开一次」不走 second-instance：
  //   · 双击一个**已经在运行**的 .app —— 系统只激活它，不会起新进程；
  //   · 点 Dock 图标 —— 同理。
  // 这两种情况都只发 'activate'。以前没有这个处理，于是「关掉控制台之后再也
  // 叫不出来」：用户以为自己在重新打开应用，应用其实一直在跑，只是没人应这一声。
  //
  // **但要挡掉启动那一次**：按 Electron 文档，'activate' 在「首次启动应用」时
  // 也会发。不挡的话就变成「每次开机都强行弹出控制台」，把用户上次「关掉它」的
  // 意图覆盖掉。启动 2 秒之后来的才算用户又点了一次图标。
  const bootAt = Date.now();
  app.on('activate', () => {
    if (Date.now() - bootAt < 2000) return;
    openConsole();
  });

  app.whenReady().then(() => {
    v2 = new V2Runtime(app.getPath('userData'));   // V2 运行时：状态/调度/存档（先于窗口）
    // V2 引擎注册（Phase 2 起依次挂入；memory 最先，供其它引擎记录）
    v2.register('memory', require('./core/memory-manager').create(v2));
    const v2Quiet = () => !!(v2.engines && v2.engines.idle && v2.engines.idle.isQuiet());
    v2.register('idle', require('./core/idle-system').create(v2, {
      onModeChange: (mode) => { goose.setQuietLevel(mode); },   // 三模式落地（normal/quiet/dnd）
    }));
    v2.register('behavior', require('./core/behavior-engine').create(v2, {
      sendToPet: (id, m) => (id === 2 ? sendPet2 : sendPet)(m),
      quietMode: v2Quiet,
    }));
    v2.register('relationship', require('./core/relationship-engine').create(v2, {
      sendToPet: (id, m) => (id === 2 ? sendPet2 : sendPet)(m),
    }));
    v2.register('event', require('./core/event-engine').create(v2, {
      sendToPet: (id, m) => (id === 2 ? sendPet2 : sendPet)(m),
      quietMode: v2Quiet,
    }));
    v2.init();   // 引擎全部注册后再初始化（恢复存档，含 relationships）
    loadSettings();
    applyAutoStart();
    createPetWindow();
    createSecondPetWindow();
    if (process.platform === 'darwin') {
      try { installFinderService(); }
      catch (e) { console.warn('[pet] 安装 Finder 右键菜单失败:', e.message); }
    }
    goose.setupGoose({
      getDogPos: () => {
        const g = geometry();
        return { x: roamX + g.boxW / 2, y: roamY + g.winH - FOOT - g.boxH / 2 };
      },
      getPetState: () => petState,
      getPet2State: () => pet2State,
      sendToPet: (m) => sendAllPet(m),
    });
    createTray();
    startRoam();
    deleteFilesFromArgv(process.argv);
    if (settings.consoleOpen || settings.console2Open) {
      openConsoleFor(settings.consoleTarget || 1);
    }

    // 分辨率 / Dock 高度 / 缩放一变，工作区和「大小」上限都要重算 ——
    // 这两个缓存就是靠这个事件失效的（另外 workArea 自己还有 1 秒 TTL 兜底）。
    screen.on('display-metrics-changed', () => {
      waCache = null; waAt = 0;
      invalidateMaxScale();
      pushGeometry();
      layoutGoalWindows();          // 球门贴着屏幕边沿，换了分辨率要重新摆
      snapshotToConsole();
    });

    const shotArg = process.argv.find((a) => a.startsWith('--shot-dir'));
    if (shotArg) selfTest(shotArg.includes('=') ? shotArg.split('=')[1] : true);
  });

  app.on('window-all-closed', () => { /* 托盘应用：关掉窗口也不退出 */ });
  app.on('before-quit', () => {
    if (ballTimer) { clearInterval(ballTimer); ballTimer = null; }
    if (ballWin && !ballWin.isDestroyed()) ballWin.destroy();
    destroyGoalWindows();
    if (pet2Win && !pet2Win.isDestroyed()) {
      // 小白的位置也记下来（下次开还在老地方）
      settings.pet2.x = Math.round(pet2X);
      settings.pet2.y = Math.round(pet2Y);
      pet2Win.destroy();
    }
    if (petWin && !petWin.isDestroyed()) settings.x = Math.round(roamX);
    try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); } catch (e) {}
    if (dragTimer) clearInterval(dragTimer);
    if (pet2DragTimer) clearInterval(pet2DragTimer);
    if (v2) v2.shutdown();                     // V2：固化存档
  });
}