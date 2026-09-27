'use strict';
/* =============================================================================
   线条小狗桌宠 —— Desktop Goose 风格捣蛋行为（渲染端侧）
   -----------------------------------------------------------------------------
   随 index.html 一起加载（script src="goose-render.js"，项目根）。职责：
     · 接收主进程 goose:cmd（steal/release/angry/chase/say）→ 播动作/台词
     · 连点狗 3 次 → 通知主进程报复（拽光标）
   动作播放走 petDesktop.gooseAct → 主进程 'goose:act' → 官方 doAction 通道。
   提示音已删除：bark 不再出声，此处也不再保留空实现。
   ============================================================================= */
(function () {
  console.log('[goose-render] loaded');
  const pd = window.petDesktop || window.pet2Desktop;
  if (!pd) return;

  // ---------------------------------------------------------------------------
  // 动作播放（走官方动作通道；动作名需在 ACTIONS 白名单里）
  // ---------------------------------------------------------------------------
  function act(name) {
    try { if (pd.gooseAct) pd.gooseAct(name); } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 戳它计数：600ms 内连点 3 下 → 报复
  // ---------------------------------------------------------------------------
  let pokeCount = 0;
  let pokeLast = 0;
  function onPointerDown() {
    const now = Date.now();
    if (now - pokeLast > 600) pokeCount = 0;
    pokeLast = now;
    pokeCount += 1;
    if (pokeCount >= 3) {
      pokeCount = 0;
      try { if (pd.gooseAction) pd.gooseAction({ type: 'poke' }); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------------------
  // 命令接收（主进程 → 本页）
  // ---------------------------------------------------------------------------
  pd.onCommand(function (msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'steal':   act('excited'); break;   // 叼住鼠标：高兴
      case 'release': break;                            // 松口：漫游自然接管
      case 'angry':   act('wrong'); break;     // 生气（无提示音）
      case 'chase':   act('run'); break;                // 报复追逐
      case 'say':                                      // 微型剧本台词 → 官方气泡
        if (msg.text && window.__petSay) window.__petSay(msg.text, msg.ms || 1600);
        break;
      default: break;
    }
  });

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------
  function init() {
    const petPos = document.getElementById('petPos');
    if (petPos) petPos.addEventListener('pointerdown', onPointerDown, true);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
