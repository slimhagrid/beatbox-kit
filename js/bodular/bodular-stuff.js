// bodular-stuff.js — Bodular core engine: rack layout, knob/jack/cable
// system, and the native Web Audio plumbing. Individual modules (VCA, LFO,
// Sample Player, etc.) live in js/bodular/modules/*.js and register
// themselves via Bodular.registerModule() before Bodular.init() runs.
window.Bodular = (function () {
  let initDone = false;
  let audioCtx = null;

  const HP_PX = 12;
  const RAIL_HP = 120;
  const CABLE_COLORS = ['#d63b2f', '#e08a00', '#3a7d44', '#4de8ff', '#b16cff', '#ff8c42', '#2f6fd6'];

  let rails = [];          // [{ el, list: [moduleId, ...] }]
  let modules = {};        // id -> instance
  let cables = [];         // [{id, fromModuleId, fromJackId, toModuleId, toJackId, color}]
  let moduleCounter = 0;
  let cableCounter = 0;
  let lastColorIdx = -1;
  let dragCable = null;    // {fromModuleId, fromJackId, color, pos:{x,y}}
  let cablesVisible = false;

  let rackEl, railsEl, canvas, ctx2d, emptyHintEl;

  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // Shared tap point for session recording: every Output module connects its
  // master gain here too (in addition to ctx.destination), so MediaRecorder
  // can capture whatever's actually playing regardless of how many Output
  // modules exist.
  let recordDestination = null;
  function getRecordDestination() {
    if (!recordDestination) recordDestination = getAudioCtx().createMediaStreamDestination();
    return recordDestination;
  }

  function nextColor() {
    lastColorIdx = (lastColorIdx + 1) % CABLE_COLORS.length;
    return CABLE_COLORS[lastColorIdx];
  }

  function fmtPct(v) { return Math.round(v * 100) + '%'; }
  function fmtX(v) { return v.toFixed(2) + 'x'; }

  // ── MODULE REGISTRY ───────────────────────────────────────────────────────
  const MODULE_DEFS = {};
  function registerModule(key, def) { MODULE_DEFS[key] = def; }

  // ── KNOB CONTROL ──────────────────────────────────────────────────────────
  let activeKnobDrag = null;

  function bindKnob(knobEl, { min, max, initial, format, onChange }) {
    let value = initial;
    const dial = knobEl.querySelector('.bodular-knob-indicator');
    const valEl = knobEl.querySelector('.bodular-knob-value');

    function render() {
      const norm = (value - min) / (max - min);
      const angle = -135 + Math.max(0, Math.min(1, norm)) * 270;
      dial.style.transform = `translateX(-50%) rotate(${angle}deg)`;
      valEl.textContent = format ? format(value) : value.toFixed(2);
    }

    function setValue(v) {
      value = Math.max(min, Math.min(max, v));
      render();
      onChange(value);
    }

    knobEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activeKnobDrag = { startY: e.clientY, startVal: value, min, max, setValue, knobEl };
      knobEl.classList.add('active');
    });

    render();
    return { setValue, get value() { return value; } };
  }

  function initGlobalKnobDrag() {
    window.addEventListener('mousemove', (e) => {
      if (!activeKnobDrag) return;
      const { startY, startVal, min, max, setValue } = activeKnobDrag;
      const dy = startY - e.clientY;
      const newVal = startVal + (dy / 150) * (max - min);
      setValue(newVal);
    });
    window.addEventListener('mouseup', () => {
      if (activeKnobDrag) {
        activeKnobDrag.knobEl.classList.remove('active');
        activeKnobDrag = null;
      }
    });
  }

  function buildKnobDom(label) {
    const wrap = document.createElement('div');
    wrap.className = 'bodular-knob';
    wrap.innerHTML = `
      <div class="bodular-knob-dial"><div class="bodular-knob-indicator"></div></div>
      <div class="bodular-knob-label">${label}</div>
      <div class="bodular-knob-value">—</div>`;
    return wrap;
  }

  // ── JACK DOM ──────────────────────────────────────────────────────────────
  function buildJackRow(moduleId, jackId, dir, label, kind = 'audio') {
    const row = document.createElement('div');
    row.className = `bodular-jack-row ${dir}`;
    const jack = document.createElement('div');
    jack.className = `bodular-jack kind-${kind}`;
    jack.dataset.module = moduleId;
    jack.dataset.jack = jackId;
    jack.dataset.dir = dir;
    const lbl = document.createElement('span');
    lbl.className = 'bodular-jack-label';
    lbl.textContent = label;
    if (dir === 'out') { row.appendChild(lbl); row.appendChild(jack); }
    else { row.appendChild(jack); row.appendChild(lbl); }
    jack.addEventListener('mousedown', (e) => onJackMouseDown(e, moduleId, jackId, dir));
    return { row, jackEl: jack };
  }

  // ── TRIGGER DETECTION (for CV/clock-driven triggers, native nodes only) ───
  // Polls an AnalyserNode for a rising edge above THRESH. Used to let a Clock
  // or LFO module fire a Sample Player or Envelope without any AudioWorklet.
  function makeTriggerInput(onRise) {
    const ctx = getAudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const buf = new Float32Array(analyser.fftSize);
    const THRESH = 0.5;
    let above = false, raf = null, stopped = false;
    function poll() {
      if (stopped) return;
      raf = requestAnimationFrame(poll);
      analyser.getFloatTimeDomainData(buf);
      const v = buf[buf.length - 1];
      if (v > THRESH && !above) { above = true; onRise(); }
      else if (v < THRESH * 0.5) { above = false; }
    }
    raf = requestAnimationFrame(poll);
    return { node: analyser, stop() { stopped = true; if (raf) cancelAnimationFrame(raf); } };
  }

  function onJackMouseDown(e, moduleId, jackId, dir) {
    e.preventDefault();
    e.stopPropagation();
    if (dir === 'in') {
      // clicking a patched input jack disconnects it; cables are always started from an output
      const existing = cables.find(c => c.toModuleId === moduleId && c.toJackId === jackId);
      if (existing) removeCable(existing.id);
      return;
    }
    dragCable = { fromModuleId: moduleId, fromJackId: jackId, color: nextColor(), pos: getJackCenter(moduleId, jackId) };
    drawCables();
  }

  function getRackRelativePos(e) {
    const rect = rackEl.getBoundingClientRect();
    return { x: e.clientX - rect.left + rackEl.scrollLeft, y: e.clientY - rect.top + rackEl.scrollTop };
  }

  function getJackCenter(moduleId, jackId) {
    const inst = modules[moduleId];
    if (!inst || !inst.jacks[jackId]) return null;
    const el = inst.jacks[jackId].el;
    const rect = el.getBoundingClientRect();
    const rackRect = rackEl.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 - rackRect.left + rackEl.scrollLeft,
      y: rect.top + rect.height / 2 - rackRect.top + rackEl.scrollTop,
    };
  }

  function initGlobalCableDrag() {
    window.addEventListener('mousemove', (e) => {
      if (!dragCable) return;
      dragCable.pos = getRackRelativePos(e);
      drawCables();
    });
    window.addEventListener('mouseup', (e) => {
      if (!dragCable) return;
      const target = e.target.closest('.bodular-jack[data-dir="in"]');
      if (target) {
        createConnection(dragCable.fromModuleId, dragCable.fromJackId, target.dataset.module, target.dataset.jack, dragCable.color);
      }
      dragCable = null;
      drawCables();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dragCable) { dragCable = null; drawCables(); }
    });
  }

  // ── CABLE GRAPH ───────────────────────────────────────────────────────────
  function createConnection(fromId, fromJack, toId, toJack, color) {
    const fromInst = modules[fromId], toInst = modules[toId];
    if (!fromInst || !toInst) return;
    const existing = cables.find(c => c.toModuleId === toId && c.toJackId === toJack);
    if (existing) removeCable(existing.id, false);
    const fromNode = fromInst.outputs[fromJack];
    const toTarget = toInst.inputs[toJack];
    if (!fromNode || !toTarget) return;
    try { fromNode.connect(toTarget); } catch (err) { console.warn('Bodular: connect failed', err); return; }
    cableCounter++;
    cables.push({ id: `c${cableCounter}`, fromModuleId: fromId, fromJackId: fromJack, toModuleId: toId, toJackId: toJack, color });
    updateJackVisualState();
  }

  function removeCable(id, redraw = true) {
    const idx = cables.findIndex(c => c.id === id);
    if (idx === -1) return;
    const c = cables[idx];
    const fromInst = modules[c.fromModuleId], toInst = modules[c.toModuleId];
    if (fromInst && toInst) {
      try { fromInst.outputs[c.fromJackId].disconnect(toInst.inputs[c.toJackId]); } catch (e) { /* already disconnected */ }
    }
    cables.splice(idx, 1);
    updateJackVisualState();
    if (redraw) drawCables();
  }

  function updateJackVisualState() {
    document.querySelectorAll('.bodular-jack.connected').forEach(el => { el.classList.remove('connected'); el.style.borderColor = ''; el.style.boxShadow = ''; });
    cables.forEach(c => {
      [[c.fromModuleId, c.fromJackId], [c.toModuleId, c.toJackId]].forEach(([mId, jId]) => {
        const inst = modules[mId];
        if (!inst || !inst.jacks[jId]) return;
        const el = inst.jacks[jId].el;
        el.classList.add('connected');
        el.style.borderColor = c.color;
        el.style.boxShadow = `0 0 0 2px ${c.color}`;
      });
    });
  }

  // ── CANVAS DRAWING ────────────────────────────────────────────────────────
  function resizeCanvas() {
    canvas.width = railsEl.scrollWidth || rackEl.clientWidth;
    canvas.height = railsEl.scrollHeight || rackEl.clientHeight;
  }

  function drawOneCable(p1, p2, color, isPreview) {
    if (!p1 || !p2) return;
    const dx = p2.x - p1.x;
    const sag = Math.min(60, Math.abs(dx) * 0.25 + 20);
    const midY = Math.max(p1.y, p2.y) + sag;
    const midX = (p1.x + p2.x) / 2;
    ctx2d.beginPath();
    ctx2d.moveTo(p1.x, p1.y);
    ctx2d.quadraticCurveTo(midX, midY, p2.x, p2.y);
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = isPreview ? 3 : 4;
    ctx2d.globalAlpha = isPreview ? 0.6 : 1;
    ctx2d.lineCap = 'round';
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
    [p1, p2].forEach(p => {
      ctx2d.beginPath();
      ctx2d.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx2d.fillStyle = color;
      ctx2d.fill();
    });
  }

  function cableEndpoints(c) {
    return [getJackCenter(c.fromModuleId, c.fromJackId), getJackCenter(c.toModuleId, c.toJackId)];
  }

  function drawCables() {
    if (!ctx2d) return;
    resizeCanvas();
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    if (cablesVisible) {
      cables.forEach(c => {
        const [p1, p2] = cableEndpoints(c);
        drawOneCable(p1, p2, c.color);
      });
    }
    // the in-progress drag preview always shows, even with the overlay toggled off
    if (dragCable) {
      drawOneCable(getJackCenter(dragCable.fromModuleId, dragCable.fromJackId), dragCable.pos, dragCable.color, true);
    }
  }

  function findCableNear(pos, threshold) {
    let best = null, bestDist = threshold;
    cables.forEach(c => {
      const [p1, p2] = cableEndpoints(c);
      if (!p1 || !p2) return;
      const dx = p2.x - p1.x;
      const sag = Math.min(60, Math.abs(dx) * 0.25 + 20);
      const midY = Math.max(p1.y, p2.y) + sag;
      const midX = (p1.x + p2.x) / 2;
      for (let t = 0; t <= 1; t += 0.04) {
        const x = (1 - t) * (1 - t) * p1.x + 2 * (1 - t) * t * midX + t * t * p2.x;
        const y = (1 - t) * (1 - t) * p1.y + 2 * (1 - t) * t * midY + t * t * p2.y;
        const dist = Math.hypot(x - pos.x, y - pos.y);
        if (dist < bestDist) { bestDist = dist; best = c; }
      }
    });
    return best;
  }

  // ── RACK / RAIL LAYOUT ────────────────────────────────────────────────────
  function railUsedHp(rail) {
    return rail.list.reduce((sum, id) => sum + (modules[id] ? modules[id].hp : 0), 0);
  }

  function addRail() {
    const railIndex = rails.length;
    const el = document.createElement('div');
    el.className = 'bodular-rail';
    const label = document.createElement('div');
    label.className = 'bodular-rail-label';
    label.textContent = `RAIL ${railIndex + 1}`;
    el.appendChild(label);
    railsEl.appendChild(el);
    rails.push({ el, list: [] });
  }

  function ensureTrailingEmptyRail() {
    if (rails.length === 0 || rails[rails.length - 1].list.length > 0) addRail();
  }

  function pruneEmptyTrailingRails() {
    while (rails.length > 1 && rails[rails.length - 1].list.length === 0 && rails[rails.length - 2].list.length === 0) {
      const removed = rails.pop();
      removed.el.remove();
    }
  }

  function findFreeSlot(hp) {
    for (let r = 0; r < rails.length; r++) {
      if (RAIL_HP - railUsedHp(rails[r]) >= hp) return r;
    }
    addRail();
    return rails.length - 1;
  }

  function updateEmptyHint() {
    const hasModules = Object.keys(modules).length > 0;
    emptyHintEl.style.display = hasModules ? 'none' : '';
  }

  function canFitInRail(railIndex, moduleId, hp) {
    const rail = rails[railIndex];
    const usedExcl = rail.list.reduce((sum, id) => sum + (id !== moduleId && modules[id] ? modules[id].hp : 0), 0);
    return usedExcl + hp <= RAIL_HP;
  }

  function moveModuleTo(moduleId, targetRailIndex, beforeModuleId) {
    const inst = modules[moduleId];
    const oldRail = rails[inst.railIndex];
    oldRail.list = oldRail.list.filter(id => id !== moduleId);
    const targetRail = rails[targetRailIndex];
    if (beforeModuleId && modules[beforeModuleId]) {
      targetRail.el.insertBefore(inst.el, modules[beforeModuleId].el);
      targetRail.list.splice(targetRail.list.indexOf(beforeModuleId), 0, moduleId);
    } else {
      targetRail.el.appendChild(inst.el);
      targetRail.list.push(moduleId);
    }
    inst.railIndex = targetRailIndex;
    ensureTrailingEmptyRail();
    pruneEmptyTrailingRails();
    requestAnimationFrame(drawCables);
  }

  // ── MODULE MOVE (drag to reposition within/across rails) ─────────────────
  let moveDrag = null; // {moduleId, ghostEl}

  function getInsertionInfo(clientX, clientY) {
    let railIndex = rails.findIndex((r) => {
      const rect = r.el.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    });
    if (railIndex === -1) {
      let best = 0, bestDist = Infinity;
      rails.forEach((r, i) => {
        const rect = r.el.getBoundingClientRect();
        const dist = Math.abs(clientY - (rect.top + rect.bottom) / 2);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      railIndex = best;
    }
    const rail = rails[railIndex];
    let beforeId = null;
    for (const id of rail.list) {
      if (id === moveDrag.moduleId) continue;
      const r = modules[id].el.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) { beforeId = id; break; }
    }
    return { railIndex, beforeId };
  }

  function positionGhost(x, y) {
    if (!moveDrag) return;
    moveDrag.ghostEl.style.left = `${x + 14}px`;
    moveDrag.ghostEl.style.top = `${y + 14}px`;
  }

  function startModuleMove(e, moduleId) {
    if (e.target.closest('.bodular-module-remove')) return;
    e.preventDefault();
    const inst = modules[moduleId];
    const ghostEl = document.createElement('div');
    ghostEl.className = 'bodular-module-ghost';
    ghostEl.textContent = `↔ ${inst.label}`;
    document.body.appendChild(ghostEl);
    moveDrag = { moduleId, ghostEl };
    inst.el.classList.add('dragging-source');
    positionGhost(e.clientX, e.clientY);
  }

  function cancelModuleMove() {
    if (!moveDrag) return;
    const inst = modules[moveDrag.moduleId];
    if (inst) inst.el.classList.remove('dragging-source');
    moveDrag.ghostEl.remove();
    moveDrag = null;
  }

  function finalizeModuleMove(clientX, clientY) {
    const { moduleId } = moveDrag;
    const inst = modules[moduleId];
    const { railIndex, beforeId } = getInsertionInfo(clientX, clientY);
    if (canFitInRail(railIndex, moduleId, inst.hp)) {
      moveModuleTo(moduleId, railIndex, beforeId);
    }
    cancelModuleMove();
  }

  function initGlobalModuleMoveDrag() {
    window.addEventListener('mousemove', (e) => {
      if (!moveDrag) return;
      positionGhost(e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', (e) => {
      if (!moveDrag) return;
      finalizeModuleMove(e.clientX, e.clientY);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && moveDrag) cancelModuleMove();
    });
  }

  // ── MODULE DOM SHELL ──────────────────────────────────────────────────────
  function buildModuleShell(instance, def) {
    const el = document.createElement('div');
    el.className = 'bodular-module';
    el.style.width = `${instance.hp * HP_PX}px`;

    const header = document.createElement('div');
    header.className = 'bodular-module-header';
    const title = document.createElement('span');
    title.className = 'bodular-module-title';
    title.textContent = instance.label;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'bodular-module-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove module';
    removeBtn.addEventListener('click', () => removeModule(instance.id));
    header.addEventListener('mousedown', (e) => startModuleMove(e, instance.id));
    header.appendChild(title);
    header.appendChild(removeBtn);

    const body = document.createElement('div');
    body.className = 'bodular-module-body';

    el.appendChild(header);
    el.appendChild(body);
    instance.el = el;
    instance.bodyEl = body;
    return el;
  }

  // ── MODULE LIFECYCLE ──────────────────────────────────────────────────────
  function countOfType(type) {
    return Object.values(modules).filter(m => m.type === type).length;
  }

  function addModule(typeKey) {
    const def = MODULE_DEFS[typeKey];
    if (!def) return;
    const railIndex = findFreeSlot(def.hp);
    moduleCounter++;
    const id = `m${moduleCounter}`;
    const instance = { id, type: typeKey, hp: def.hp, label: `${def.name} ${countOfType(typeKey) + 1}`, railIndex };

    buildModuleShell(instance, def);
    rails[railIndex].list.push(id);
    rails[railIndex].el.appendChild(instance.el);
    modules[id] = instance;

    def.build(instance);

    ensureTrailingEmptyRail();
    updateEmptyHint();
    requestAnimationFrame(drawCables);
  }

  function removeModule(id) {
    const inst = modules[id];
    if (!inst) return;
    cables.filter(c => c.fromModuleId === id || c.toModuleId === id).forEach(c => removeCable(c.id, false));
    const def = MODULE_DEFS[inst.type];
    if (def && def.cleanup) def.cleanup(inst);
    rails[inst.railIndex].list = rails[inst.railIndex].list.filter(mid => mid !== id);
    inst.el.remove();
    delete modules[id];
    pruneEmptyTrailingRails();
    updateEmptyHint();
    requestAnimationFrame(drawCables);
  }

  function clearAll() {
    Object.keys(modules).forEach(removeModule);
  }

  // ── TOOLBAR ───────────────────────────────────────────────────────────────
  function initToolbar() {
    const addBtn = document.getElementById('bodular-add-btn');
    const addMenu = document.getElementById('bodular-add-menu');

    function closeAllCategories() {
      addMenu.querySelectorAll('.bodular-add-category.open').forEach((c) => c.classList.remove('open'));
    }
    function closeMenu() {
      addMenu.classList.remove('open');
      closeAllCategories();
    }

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !addMenu.classList.contains('open');
      closeMenu();
      if (willOpen) addMenu.classList.add('open');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.bodular-add-wrap')) closeMenu();
    });

    addMenu.querySelectorAll('.bodular-add-cat-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cat = btn.closest('.bodular-add-category');
        const wasOpen = cat.classList.contains('open');
        closeAllCategories();
        if (!wasOpen) cat.classList.add('open');
      });
    });

    addMenu.querySelectorAll('.bodular-add-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        addModule(btn.dataset.type);
        closeMenu();
      });
    });

    const clearBtn = document.getElementById('bodular-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', clearAll);

    const cableToggleBtn = document.getElementById('bodular-cable-toggle-btn');
    if (cableToggleBtn) {
      cableToggleBtn.addEventListener('click', () => setCablesVisible(!cablesVisible, cableToggleBtn));
      updateCableToggleBtn(cableToggleBtn);
    }

    const recordBtn = document.getElementById('bodular-record-btn');
    if (recordBtn) {
      recordBtn.addEventListener('click', () => { isRecording ? stopRecording() : startRecording(); });
    }
  }

  function updateCableToggleBtn(btn) {
    btn = btn || document.getElementById('bodular-cable-toggle-btn');
    if (!btn) return;
    btn.classList.toggle('active', cablesVisible);
    btn.innerHTML = `<kbd>C</kbd> ${cablesVisible ? 'Hide' : 'Show'} Cables`;
  }

  function setCablesVisible(visible, btn) {
    cablesVisible = visible;
    updateCableToggleBtn(btn);
    drawCables();
  }

  // ── SESSION RECORDING ─────────────────────────────────────────────────────
  // Modules are rendered as real DOM (knobs, buttons, panels) rather than one
  // big canvas, so there's no single element to capture a video stream from.
  // getDisplayMedia is the only dependency-free way to record that — the
  // browser's native "choose what to share" picker shows up once, and the
  // user should pick this tab/window. Audio is captured separately and more
  // reliably straight from the Web Audio graph via getRecordDestination().
  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let displayStream = null;

  function setAddModuleEnabled(enabled) {
    const addBtn = document.getElementById('bodular-add-btn');
    if (addBtn) addBtn.disabled = !enabled;
    if (!enabled) {
      const addMenu = document.getElementById('bodular-add-menu');
      if (addMenu) {
        addMenu.classList.remove('open');
        addMenu.querySelectorAll('.bodular-add-category.open').forEach((c) => c.classList.remove('open'));
      }
    }
  }

  function updateRecordBtn() {
    const btn = document.getElementById('bodular-record-btn');
    if (!btn) return;
    btn.classList.toggle('recording', isRecording);
    btn.textContent = isRecording ? '■' : '⏺';
  }

  function downloadRecording(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    a.href = url;
    a.download = `bodular-session-${mm}-${dd}-${now.getFullYear()}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function startRecording() {
    if (isRecording) return;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
        preferCurrentTab: true, // Chrome-only hint; harmlessly ignored elsewhere
      });
    } catch (err) {
      console.warn('Bodular: recording cancelled', err);
      return;
    }

    const audioTracks = getRecordDestination().stream.getAudioTracks();
    const combined = new MediaStream([...displayStream.getVideoTracks(), ...audioTracks]);
    const mimeType = (window.MediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus'))
      ? 'video/webm;codecs=vp9,opus' : 'video/webm';

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(combined, { mimeType });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      downloadRecording(new Blob(recordedChunks, { type: 'video/webm' }));
      displayStream.getTracks().forEach((t) => t.stop());
      displayStream = null;
    };
    displayStream.getVideoTracks()[0].addEventListener('ended', stopRecording);

    mediaRecorder.start();
    isRecording = true;
    updateRecordBtn();
    setAddModuleEnabled(false);
  }

  function stopRecording() {
    if (!isRecording) return;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    isRecording = false;
    updateRecordBtn();
    setAddModuleEnabled(true);
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    if (initDone) return;
    initDone = true;

    rackEl = document.getElementById('bodular-rack');
    railsEl = document.getElementById('bodular-rails');
    canvas = document.getElementById('bodular-cable-canvas');
    emptyHintEl = document.getElementById('bodular-empty-hint');
    ctx2d = canvas.getContext('2d');

    initToolbar();
    initGlobalKnobDrag();
    initGlobalCableDrag();
    initGlobalModuleMoveDrag();

    // hit-testing lives on the rack (not the canvas) since the canvas is
    // pointer-events:none — modules sit visually under the cable overlay but
    // still need to receive clicks for their jacks/knobs/buttons.
    rackEl.addEventListener('mousedown', (e) => {
      if (dragCable || moveDrag || !cablesVisible) return;
      if (e.target.closest('.bodular-jack, .bodular-knob, button, input, .bodular-module-header')) return;
      const pos = getRackRelativePos(e);
      const hit = findCableNear(pos, 10);
      if (hit) removeCable(hit.id);
    });

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key.toLowerCase() === 'c') setCablesVisible(!cablesVisible);
    });

    window.addEventListener('resize', () => requestAnimationFrame(drawCables));
    rackEl.addEventListener('scroll', () => { /* canvas is inside scroll content, no redraw needed */ });

    ensureTrailingEmptyRail();
    updateEmptyHint();
    resizeCanvas();
  }

  return {
    init, addModule, removeModule, clearAll, registerModule,
    lib: { getAudioCtx, getRecordDestination, buildKnobDom, bindKnob, buildJackRow, makeTriggerInput, fmtPct, fmtX },
  };
})();
