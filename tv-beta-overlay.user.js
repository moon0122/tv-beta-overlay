// ==UserScript==
// @name         TradingView 叠图 β 计算器
// @namespace    panoramic.tv.beta
// @version      1.2.2
// @description  读取 TradingView 当前窗格中两条价格轴的可见区间，按 β = ln(1+主图涨幅) / ln(1+副图涨幅) 实时计算贝塔系数
// @author       Xiangjin
// @license      MIT
// @homepageURL  https://github.com/moon0122/tv-beta-overlay
// @updateURL    https://raw.githubusercontent.com/moon0122/tv-beta-overlay/main/tv-beta-overlay.user.js
// @downloadURL  https://raw.githubusercontent.com/moon0122/tv-beta-overlay/main/tv-beta-overlay.user.js
// @match        https://www.tradingview.com/chart/*
// @match        https://*.tradingview.com/chart/*
// @match        https://cn.tradingview.com/chart/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 配置 ----------
  const POLL_MS = 400;          // 轮询间隔（轴缩放没有公开事件，轮询最稳）
  const DECIMALS = 4;           // β 显示小数位
  const MODE_NAME = { 0: '线性', 1: '对数', 2: '百分比', 3: '指数化100' };

  // ---------- 状态 ----------
  let paneIdx = 0;
  let mainKey = null, subKey = null;   // 轴标识，如 "R0" / "L1"；null 表示用默认（右1 / 左1）
  let collapsed = false;
  let lastSig = '';
  let forceShow = false;               // 通过 Tampermonkey 菜单强制显示
  let enoughAxes = false;              // 当前窗格是否有 ≥2 条价格轴

  // ---------- UI ----------
  const css = `
  #tvb-root{position:fixed;right:70px;bottom:40px;z-index:999999;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
    background:rgba(19,23,34,.94);color:#d1d4dc;border:1px solid #363a45;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);min-width:240px;user-select:none}
  #tvb-head{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;cursor:move;border-bottom:1px solid #2a2e39;font-weight:600}
  #tvb-head span.btn{cursor:pointer;opacity:.7;margin-left:8px}
  #tvb-head span.btn:hover{opacity:1}
  #tvb-body{padding:8px 10px}
  #tvb-beta{font-size:26px;font-weight:700;letter-spacing:.5px;margin:2px 0 6px;color:#2962ff}
  #tvb-beta.bad{color:#f23645}
  .tvb-row{display:flex;justify-content:space-between;gap:10px;white-space:nowrap;align-items:center}
  .tvb-row .k{color:#787b86}
  .tvb-warn{color:#ff9800;margin-top:6px;white-space:normal;max-width:270px}
  .tvb-sel{display:flex;gap:6px;margin-top:6px;align-items:center}
  select.tvb-ax{background:#1e222d;color:#d1d4dc;border:1px solid #363a45;border-radius:4px;font-size:11px}
  #tvb-root.collapsed #tvb-body{display:none}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'tvb-root';
  root.innerHTML = `
    <div id="tvb-head"><span>β 叠图锚定</span><span><span class="btn" id="tvb-copy" title="复制 β">⧉</span><span class="btn" id="tvb-tgl" title="折叠">—</span></span></div>
    <div id="tvb-body">
      <div id="tvb-beta">—</div>
      <div class="tvb-row"><span class="k">主图 <select class="tvb-ax" id="tvb-msel"></select></span><span id="tvb-m">—</span></div>
      <div class="tvb-row"><span class="k">副图 <select class="tvb-ax" id="tvb-ssel"></select></span><span id="tvb-s">—</span></div>
      <div class="tvb-row"><span class="k">主图区间涨幅</span><span id="tvb-mp">—</span></div>
      <div class="tvb-row"><span class="k">副图区间涨幅</span><span id="tvb-sp">—</span></div>
      <div class="tvb-sel"><span class="k">窗格</span><select class="tvb-ax" id="tvb-psel"></select></div>
      <div class="tvb-warn" id="tvb-warn"></div>
    </div>`;
  document.body.appendChild(root);
  root.style.display = 'none';   // 默认隐藏，窗格有 ≥2 条轴或菜单强制显示时再出现

  const $ = id => root.querySelector('#' + id);
  const elBeta = $('tvb-beta'), elM = $('tvb-m'), elS = $('tvb-s'), elMp = $('tvb-mp'), elSp = $('tvb-sp'), elWarn = $('tvb-warn');
  const selM = $('tvb-msel'), selS = $('tvb-ssel'), selP = $('tvb-psel');

  selM.addEventListener('change', () => { mainKey = selM.value; lastSig = ''; });
  selS.addEventListener('change', () => { subKey = selS.value; lastSig = ''; });
  selP.addEventListener('change', () => { paneIdx = +selP.value; mainKey = subKey = null; lastSig = ''; });
  $('tvb-tgl').addEventListener('click', () => { collapsed = !collapsed; root.classList.toggle('collapsed', collapsed); });
  $('tvb-copy').addEventListener('click', () => {
    const t = elBeta.textContent.trim();
    if (t && t !== '—') navigator.clipboard && navigator.clipboard.writeText(t);
  });

  function applyVisibility() {
    root.style.display = (enoughAxes || forceShow) ? '' : 'none';
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('显示 / 隐藏 β 浮窗', () => {
      forceShow = !forceShow;
      applyVisibility();
    });
  }

  // 拖动
  (function drag() {
    const head = $('tvb-head');
    let sx, sy, ox, oy, on = false;
    head.addEventListener('mousedown', e => {
      if (e.target.classList.contains('btn')) return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect(); ox = r.left; oy = r.top;
      root.style.right = 'auto'; root.style.bottom = 'auto';
      root.style.left = ox + 'px'; root.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!on) return;
      root.style.left = (ox + e.clientX - sx) + 'px';
      root.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { on = false; });
  })();

  // ---------- 数据读取 ----------
  // 有 GM 授权时脚本跑在沙箱里，页面全局要通过 unsafeWindow 读
  const pageWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  function getChart() {
    const api = pageWin.TradingViewApi;
    if (!api || typeof api.activeChart !== 'function') return null;
    try { return api.activeChart(); } catch (e) { return null; }
  }

  function readScale(scale) {
    if (!scale) return null;
    let range = null, mode = null, inverted = false;
    try { range = scale.getVisiblePriceRange(); } catch (e) {}
    try { mode = scale.getMode(); } catch (e) {}
    try { inverted = !!scale.isInverted(); } catch (e) {}
    if (!range || !isFinite(range.from) || !isFinite(range.to)) return null;
    const lo = Math.min(range.from, range.to), hi = Math.max(range.from, range.to);
    return { lo, hi, mode, inverted };
  }

  // 把窗格里所有价格轴收成一个列表：[{key:"R0", label:"右1", scale}, {key:"L0", label:"左1", scale}, ...]
  function listAxes(pane) {
    let rights = [], lefts = [];
    try { rights = pane.getRightPriceScales() || []; } catch (e) {}
    try { lefts = pane.getLeftPriceScales() || []; } catch (e) {}
    const out = [];
    rights.forEach((s, i) => out.push({ key: 'R' + i, label: '右' + (i + 1), scale: s }));
    lefts.forEach((s, i) => out.push({ key: 'L' + i, label: '左' + (i + 1), scale: s }));
    return out;
  }

  function fmtPrice(v) {
    const a = Math.abs(v);
    const d = a >= 1000 ? 2 : a >= 1 ? 4 : 6;
    return v.toFixed(d).replace(/\.?0+$/, '');
  }
  function fmtPct(x) { return (x * 100).toFixed(2) + '%'; }

  function syncAxisSelect(sel, axes, cur) {
    const sig = axes.map(a => a.key).join(',');
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = '';
      axes.forEach(a => {
        const o = document.createElement('option');
        o.value = a.key; o.textContent = a.label;
        sel.appendChild(o);
      });
      sel.dataset.sig = sig;
    }
    sel.value = cur;
  }
  function syncPaneSelect(n, cur) {
    if (selP.options.length !== n) {
      selP.innerHTML = '';
      for (let i = 0; i < n; i++) {
        const o = document.createElement('option');
        o.value = i; o.textContent = '窗格' + (i + 1);
        selP.appendChild(o);
      }
    }
    selP.value = cur;
    selP.parentElement.style.display = n > 1 ? '' : 'none';
  }

  function tick() {
    const chart = getChart();
    if (!chart) { enoughAxes = false; applyVisibility(); show(null, null, '等待 TradingView 图表 API 加载…'); return; }

    let panes = [];
    try { panes = chart.getPanes() || []; } catch (e) {}
    if (!panes.length) { enoughAxes = false; applyVisibility(); show(null, null, '读不到窗格'); return; }
    if (paneIdx >= panes.length) paneIdx = 0;
    syncPaneSelect(panes.length, paneIdx);

    const axes = listAxes(panes[paneIdx]);
    enoughAxes = axes.length >= 2;
    applyVisibility();
    if (!enoughAxes && !forceShow) { lastSig = ''; return; }

    // 默认：主图 = 第一条右轴，副图 = 第一条左轴；缺哪边就退到列表里另一条
    const keys = axes.map(a => a.key);
    if (!keys.includes(mainKey)) mainKey = keys.find(k => k[0] === 'R') || keys[0] || null;
    if (!keys.includes(subKey) || subKey === mainKey) subKey = keys.find(k => k[0] === 'L' && k !== mainKey) || keys.find(k => k !== mainKey) || null;
    syncAxisSelect(selM, axes, mainKey);
    syncAxisSelect(selS, axes, subKey);

    const mAx = axes.find(a => a.key === mainKey), sAx = axes.find(a => a.key === subKey);
    const M = readScale(mAx && mAx.scale);
    const S = readScale(sAx && sAx.scale);

    const warns = [];
    if (axes.length < 2) warns.push('当前窗格只有 ' + axes.length + ' 条价格轴，需要把叠图放到另一条轴上。');
    if (M && M.mode !== 1) warns.push('主图轴不是对数坐标（当前：' + (MODE_NAME[M.mode] || M.mode) + '），β 不可靠。');
    if (S && S.mode !== 1) warns.push('副图轴不是对数坐标（当前：' + (MODE_NAME[S.mode] || S.mode) + '），β 不可靠。');
    if (M && S && (M.inverted !== S.inverted)) warns.push('两轴反转状态不一致。');

    const sig = JSON.stringify([mainKey, subKey, M, S, warns]);
    if (sig === lastSig) return;
    lastSig = sig;
    show(M, S, warns.join(' '));
  }

  function show(M, S, warn) {
    elWarn.textContent = warn || '';
    elM.textContent = M ? fmtPrice(M.lo) + ' → ' + fmtPrice(M.hi) : '—';
    elS.textContent = S ? fmtPrice(S.lo) + ' → ' + fmtPrice(S.hi) : '—';
    if (!M || !S || M.lo <= 0 || S.lo <= 0) {
      elBeta.textContent = '—'; elMp.textContent = elSp.textContent = '—';
      elBeta.classList.add('bad');
      if ((M && M.lo <= 0) || (S && S.lo <= 0)) elWarn.textContent += ' 轴下界 ≤ 0，对数无意义。';
      return;
    }
    const mRet = M.hi / M.lo - 1;      // 主图区间涨幅
    const sRet = S.hi / S.lo - 1;      // 副图区间涨幅
    const num = Math.log(1 + mRet);    // = ln(M.hi/M.lo)
    const den = Math.log(1 + sRet);    // = ln(S.hi/S.lo)
    elMp.textContent = fmtPct(mRet);
    elSp.textContent = fmtPct(sRet);
    if (Math.abs(den) < 1e-12) { elBeta.textContent = '∞'; elBeta.classList.add('bad'); return; }
    const beta = num / den;
    elBeta.textContent = beta.toFixed(DECIMALS);
    elBeta.classList.toggle('bad', !!warn);
  }

  setInterval(tick, POLL_MS);
  tick();
})();
