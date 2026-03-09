// ==UserScript==
// @name         Coreum Central - Alerta ECG WinCardio
// @namespace    https://classic.coreum.health/
// @version      1.1.1
// @description  Alertas para novos ECG WINCARDIO, SLA <= 2 min e SLA vencido, com painel clean e prevenção de duplicados.
// @author       Ryan
// @match        https://classic.coreum.health/classic/central*
// @updateURL    https://raw.githubusercontent.com/ryanrn/Script-Atualizacao-ECG/main/coreum-central-alerta.user.js
// @downloadURL  https://raw.githubusercontent.com/ryanrn/Script-Atualizacao-ECG/main/coreum-central-alerta.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const CONFIG = {
    debug: false,

    selectors: {
      examCard: '.painel-exame',
      examTypeHeader: '.col-sm-1.text-center'
    },

    scanIntervalMs: 2500,
    observerDebounceMs: 300,

    filterExamType: 'ecg wincardio',

    expiringThresholdSec: 120,
    overdueBeepEveryMs: 5000,

    seenTtlMs: 3 * 60 * 60 * 1000, // 3h
    maxSeenKeys: 350,

    audio: {
      newExam: {
        count: 3,
        freq: 880,
        durationMs: 180,
        gapMs: 420,
        gain: 0.8
      },
      expiring: {
        count: 3,
        freq: 760,
        durationMs: 170,
        gapMs: 420,
        gain: 0.8
      },
      overdue: {
        freq: 980,
        durationMs: 140,
        gain: 0.8
      }
    },

    keepAlive: {
      frequencyHz: 18500,
      gain: 0.00001
    },

    ui: {
      zIndex: 2147483647
    }
  };

  const STORAGE_KEYS = {
    settings: 'coreum_ecg_alerts_settings_v1',
    seen: 'coreum_ecg_alerts_seen_v1',
    sessionExpiring: 'coreum_ecg_alerts_session_expiring_v1',
    sessionOverdue: 'coreum_ecg_alerts_session_overdue_v1'
  };

  const state = {
    initialized: false,
    initialBootstrapDone: false,

    settings: null,
    seenStore: null,
    sessionExpiringWarned: null,
    sessionOverdueWarned: null,

    stats: {
      detectedCount: 0,
      lastScanAt: 0
    },

    scanTimerId: null,
    observer: null,
    observerScanTimerId: null,

    overdueIntervals: new Map(),
    currentVisibleOverdueKeys: new Set(),

    audioCtx: null,
    keepAliveNodes: null,

    ui: {
      panel: null
    }
  };

  function log(...args) {
    if (CONFIG.debug) {
      console.log('[Coreum ECG Alerts]', ...args);
    }
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripAccents(value) {
    return cleanText(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function normalizeForCompare(value) {
    return stripAccents(value).toLowerCase();
  }

  function parseHMS(hms) {
    const match = cleanText(hms).match(/^(\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    const s = Number(match[3]);
    return (h * 3600) + (m * 60) + s;
  }

  function hash32(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash >>> 0;
    }
    return hash.toString(16);
  }

  function buildExamKey(data) {
    const canonical = [
      data.examType || '?',
      data.patientName || '?',
      data.examDate || '?',
      data.receivedDate || '?',
      data.remoteSite || '?'
    ]
      .map(normalizeForCompare)
      .join('|');

    return `${canonical}::${hash32(canonical)}`;
  }

  function isRelevantExamType(value) {
    return normalizeForCompare(value).includes(normalizeForCompare(CONFIG.filterExamType));
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      log('Failed to load JSON', key, err);
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      log('Failed to save JSON', key, err);
    }
  }

  function loadSessionArray(key) {
    try {
      const raw = sessionStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (err) {
      log('Failed to load session array', key, err);
      return new Set();
    }
  }

  function saveSessionArray(key, setObj) {
    try {
      sessionStorage.setItem(key, JSON.stringify(Array.from(setObj)));
    } catch (err) {
      log('Failed to save session array', key, err);
    }
  }

  function loadSettings() {
    const defaults = {
      soundEnabled: true,
      notificationsEnabled: true,
      paused: false,
      keepAliveEnabled: false
    };
    const saved = loadJSON(STORAGE_KEYS.settings, {});
    return Object.assign({}, defaults, saved || {});
  }

  function saveSettings() {
    saveJSON(STORAGE_KEYS.settings, state.settings);
    updatePanel();
  }

  function loadSeenStore() {
    const fallback = { items: {} };
    const loaded = loadJSON(STORAGE_KEYS.seen, fallback);
    if (!loaded || typeof loaded !== 'object' || typeof loaded.items !== 'object') {
      return fallback;
    }
    return loaded;
  }

  function pruneSeenStore() {
    const now = Date.now();
    const items = state.seenStore.items || {};

    for (const [key, ts] of Object.entries(items)) {
      if (!Number.isFinite(ts) || (now - ts) > CONFIG.seenTtlMs) {
        delete items[key];
      }
    }

    const entries = Object.entries(items);
    if (entries.length > CONFIG.maxSeenKeys) {
      entries.sort((a, b) => a[1] - b[1]);
      const excess = entries.length - CONFIG.maxSeenKeys;
      for (let i = 0; i < excess; i++) {
        delete items[entries[i][0]];
      }
    }
  }

  function saveSeenStore() {
    pruneSeenStore();
    saveJSON(STORAGE_KEYS.seen, state.seenStore);
  }

  function hasSeen(key) {
    return Boolean(state.seenStore.items && state.seenStore.items[key]);
  }

  function markSeen(key) {
    state.seenStore.items[key] = Date.now();
  }

  function getNotificationPermission() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }

  async function requestNotificationPermission() {
    if (!('Notification' in window)) {
      window.alert('Este navegador não suporta Notification API.');
      updatePanel();
      return 'unsupported';
    }

    try {
      const result = await Notification.requestPermission();
      updatePanel();
      return result;
    } catch (err) {
      log('Notification permission request failed', err);
      updatePanel();
      return getNotificationPermission();
    }
  }

  function getAudioStateLabel() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return 'unsupported';
    if (!state.audioCtx) return 'blocked';
    return state.audioCtx.state;
  }

  async function ensureAudioContext() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;

    if (!state.audioCtx) {
      state.audioCtx = new AudioCtor();
      updatePanel();
    }
    return state.audioCtx;
  }

  async function enableAudioFromGesture() {
    const ctx = await ensureAudioContext();
    if (!ctx) {
      window.alert('AudioContext não suportado neste navegador.');
      return;
    }

    try {
      await ctx.resume();
      syncKeepAlive();
      updatePanel();
    } catch (err) {
      log('Audio resume failed', err);
      updatePanel();
    }
  }

  function createScheduledBeep(ctx, startTime, freq, durationMs, gainValue) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(gainValue, 0.0002), startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + (durationMs / 1000));

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + (durationMs / 1000) + 0.02);

    osc.onended = function () {
      try { osc.disconnect(); } catch (_) {}
      try { gain.disconnect(); } catch (_) {}
    };
  }

  async function playBeepPattern(pattern) {
    if (!state.settings.soundEnabled) return false;

    const ctx = await ensureAudioContext();
    if (!ctx) return false;

    try {
      if (ctx.state !== 'running') {
        await ctx.resume().catch(() => {});
      }
    } catch (_) {}

    if (ctx.state !== 'running') {
      updatePanel();
      return false;
    }

    const base = ctx.currentTime + 0.02;
    for (const entry of pattern) {
      createScheduledBeep(
        ctx,
        base + ((entry.delayMs || 0) / 1000),
        entry.freq,
        entry.durationMs,
        entry.gain
      );
    }

    updatePanel();
    return true;
  }

  function buildTriplePattern(config) {
    const pattern = [];
    for (let i = 0; i < config.count; i++) {
      pattern.push({
        delayMs: i * config.gapMs,
        freq: config.freq,
        durationMs: config.durationMs,
        gain: config.gain
      });
    }
    return pattern;
  }

  async function playNewExamBeep() {
    return playBeepPattern(buildTriplePattern(CONFIG.audio.newExam));
  }

  async function playExpiringBeep() {
    return playBeepPattern(buildTriplePattern(CONFIG.audio.expiring));
  }

  async function playOverdueSingleBeep() {
    return playBeepPattern([{
      delayMs: 0,
      freq: CONFIG.audio.overdue.freq,
      durationMs: CONFIG.audio.overdue.durationMs,
      gain: CONFIG.audio.overdue.gain
    }]);
  }

  function startKeepAlive() {
    if (!state.audioCtx || state.audioCtx.state !== 'running' || state.keepAliveNodes) return;

    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.value = CONFIG.keepAlive.frequencyHz;
    gain.gain.value = CONFIG.keepAlive.gain;

    osc.connect(gain);
    gain.connect(state.audioCtx.destination);
    osc.start();

    state.keepAliveNodes = { osc, gain };
    log('Keep Alive started');
  }

  function stopKeepAlive() {
    if (!state.keepAliveNodes) return;

    try { state.keepAliveNodes.osc.stop(); } catch (_) {}
    try { state.keepAliveNodes.osc.disconnect(); } catch (_) {}
    try { state.keepAliveNodes.gain.disconnect(); } catch (_) {}

    state.keepAliveNodes = null;
    log('Keep Alive stopped');
  }

  function syncKeepAlive() {
    if (state.settings.keepAliveEnabled && state.audioCtx && state.audioCtx.state === 'running') {
      startKeepAlive();
    } else {
      stopKeepAlive();
    }
    updatePanel();
  }

  function composeNotificationBody(data) {
    const lines = [];
    lines.push(`Exame: ${data.examType || '-'}`);
    lines.push(`Paciente: ${data.patientName || '-'}`);
    lines.push(`Ponto Remoto: ${data.remoteSite || '-'}`);
    lines.push(`Recebido: ${data.receivedDate || '-'}`);
    lines.push(`Emergência: ${data.emergencyFlag || '-'}`);

    if (data.timerLabel && data.timerText) {
      const timerLabelText = data.timerLabel === 'tempo ultrapassado'
        ? 'Tempo Ultrapassado'
        : 'Tempo Restante';
      lines.push(`${timerLabelText}: ${data.timerText}`);
    }

    return lines.join('\n');
  }

  function sendNotification(kind, data) {
    if (!state.settings.notificationsEnabled) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    let title = 'Coreum Central';
    if (kind === 'new') title = 'Novo ECG WINCARDIO na fila';
    if (kind === 'expiring') title = 'SLA perto de vencer (<= 2 min)';
    if (kind === 'overdue') title = 'SLA vencido';

    try {
      new Notification(title, {
        body: composeNotificationBody(data),
        tag: `coreum-${kind}-${data.key}`,
        renotify: true,
        requireInteraction: kind === 'overdue'
      });
    } catch (err) {
      log('Notification failed', err);
    }
  }

  function extractItemData(cardEl) {
    if (!cardEl) return null;

    const lines = Array.from(cardEl.querySelectorAll('label, .col-sm-1.text-center'))
      .map(el => cleanText(el.textContent))
      .filter(Boolean);

    const headerEl = cardEl.querySelector(CONFIG.selectors.examTypeHeader);
    let examType = cleanText(headerEl ? headerEl.textContent : '');

    function findValue(regex) {
      for (const line of lines) {
        const match = line.match(regex);
        if (match) return cleanText(match[1]);
      }
      return '';
    }

    if (!examType) {
      examType = findValue(/^Tipo de Exame:\s*(.+)$/i);
    }

    if (!isRelevantExamType(examType)) {
      return null;
    }

    const patientName = findValue(/^Paciente:\s*(.+)$/i);
    const remoteSite = findValue(/^Ponto Remoto:\s*(.+)$/i);
    const examDate = findValue(/^Data do Exame:\s*(.+)$/i);
    const receivedDate = findValue(/^Data do Recebimento:\s*(.+)$/i);
    const emergencyFlag = findValue(/^Emerg[eê]ncia:\s*(.+)$/i);
    const slaText = findValue(/^SLA:\s*(.+)$/i);

    let timerLabel = '';
    let timerText = '';

    for (const line of lines) {
      let match = line.match(/^Tempo Restante:\s*(\d{2}:\d{2}:\d{2})$/i);
      if (match) {
        timerLabel = 'tempo restante';
        timerText = cleanText(match[1]);
        break;
      }

      match = line.match(/^Tempo Ultrapassado:\s*(\d{2}:\d{2}:\d{2})$/i);
      if (match) {
        timerLabel = 'tempo ultrapassado';
        timerText = cleanText(match[1]);
        break;
      }
    }

    let remainingSec = null;
    let isOverdue = false;

    if (timerLabel === 'tempo restante') {
      remainingSec = parseHMS(timerText);
      if (remainingSec !== null && remainingSec <= 0) {
        isOverdue = true;
      }
    } else if (timerLabel === 'tempo ultrapassado') {
      remainingSec = 0;
      isOverdue = true;
    }

    const data = {
      examType,
      patientName,
      remoteSite,
      examDate,
      receivedDate,
      emergencyFlag,
      slaText,
      timerLabel,
      timerText,
      remainingSec,
      isOverdue
    };

    data.key = buildExamKey(data);
    return data;
  }

  async function handleNewExam(data) {
    log('New exam alert', data);
    sendNotification('new', data);
    await playNewExamBeep();
  }

  async function handleExpiring(data) {
    log('Expiring alert', data);
    sendNotification('expiring', data);
    await playExpiringBeep();
  }

  async function handleOverdueOnce(data) {
    log('Overdue alert', data);
    sendNotification('overdue', data);
    await playOverdueSingleBeep();
  }

  function ensureOverdueLoop(key) {
    if (state.overdueIntervals.has(key)) return;

    const intervalId = window.setInterval(() => {
      void playOverdueSingleBeep();
    }, CONFIG.overdueBeepEveryMs);

    state.overdueIntervals.set(key, { intervalId });
    updatePanel();
  }

  function stopOverdueLoop(key) {
    const entry = state.overdueIntervals.get(key);
    if (!entry) return;

    clearInterval(entry.intervalId);
    state.overdueIntervals.delete(key);
    updatePanel();
  }

  function stopAllOverdueLoops() {
    for (const key of Array.from(state.overdueIntervals.keys())) {
      stopOverdueLoop(key);
    }
  }

  function persistSessionSets() {
    saveSessionArray(STORAGE_KEYS.sessionExpiring, state.sessionExpiringWarned);
    saveSessionArray(STORAGE_KEYS.sessionOverdue, state.sessionOverdueWarned);
  }

  function scanQueue(reason, force) {
    try {
      if (state.settings.paused && !force) {
        state.stats.lastScanAt = Date.now();
        updatePanel();
        return;
      }

      pruneSeenStore();

      const cards = Array.from(document.querySelectorAll(CONFIG.selectors.examCard));
      const relevantItems = [];
      const visibleOverdueKeys = new Set();

      let seenDirty = false;
      let sessionDirty = false;

      for (const card of cards) {
        const data = extractItemData(card);
        if (!data) continue;

        relevantItems.push(data);

        if (!state.initialBootstrapDone) {
          if (!hasSeen(data.key)) {
            markSeen(data.key);
            seenDirty = true;
          }
        } else {
          if (!hasSeen(data.key)) {
            markSeen(data.key);
            seenDirty = true;
            void handleNewExam(data);
          }
        }

        const expiringNow =
          data.timerLabel === 'tempo restante' &&
          Number.isFinite(data.remainingSec) &&
          data.remainingSec > 0 &&
          data.remainingSec <= CONFIG.expiringThresholdSec;

        if (expiringNow && !state.sessionExpiringWarned.has(data.key)) {
          state.sessionExpiringWarned.add(data.key);
          sessionDirty = true;
          void handleExpiring(data);
        }

        if (data.isOverdue) {
          visibleOverdueKeys.add(data.key);

          if (!state.sessionOverdueWarned.has(data.key)) {
            state.sessionOverdueWarned.add(data.key);
            sessionDirty = true;
            void handleOverdueOnce(data);
          }

          ensureOverdueLoop(data.key);
        } else {
          stopOverdueLoop(data.key);
        }
      }

      for (const key of Array.from(state.overdueIntervals.keys())) {
        if (!visibleOverdueKeys.has(key)) {
          stopOverdueLoop(key);
        }
      }

      if (seenDirty) saveSeenStore();
      if (sessionDirty) persistSessionSets();

      state.currentVisibleOverdueKeys = visibleOverdueKeys;
      state.stats.detectedCount = relevantItems.length;
      state.stats.lastScanAt = Date.now();

      if (!state.initialBootstrapDone) {
        state.initialBootstrapDone = true;
        log(`Bootstrap complete (${relevantItems.length} ECG items visible). Reason:`, reason);
      } else {
        log(`Scan completed (${reason}) - ECG items: ${relevantItems.length}`);
      }

      updatePanel();
    } catch (err) {
      console.error('[Coreum ECG Alerts] scanQueue error:', err);
    }
  }

  function scheduleObserverScan() {
    clearTimeout(state.observerScanTimerId);
    state.observerScanTimerId = window.setTimeout(() => {
      scanQueue('observer', false);
    }, CONFIG.observerDebounceMs);
  }

  function startObserver() {
    if (state.observer) return;
    if (!document.body) return;

    state.observer = new MutationObserver((mutations) => {
      let shouldScan = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          if (mutation.addedNodes.length || mutation.removedNodes.length) {
            shouldScan = true;
            break;
          }
        }

        if (mutation.type === 'characterData') {
          shouldScan = true;
          break;
        }
      }

      if (shouldScan) {
        scheduleObserverScan();
      }
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function startIntervalScan() {
    if (state.scanTimerId) return;
    state.scanTimerId = window.setInterval(() => {
      scanQueue('interval', false);
    }, CONFIG.scanIntervalMs);
  }

  function stopScanningInfrastructure() {
    if (state.scanTimerId) {
      clearInterval(state.scanTimerId);
      state.scanTimerId = null;
    }

    if (state.observer) {
      try { state.observer.disconnect(); } catch (_) {}
      state.observer = null;
    }

    clearTimeout(state.observerScanTimerId);
    state.observerScanTimerId = null;
  }

  function createStyles() {
    const oldStyle = document.getElementById('coreum-ecg-alert-style');
    if (oldStyle) oldStyle.remove();

    const style = document.createElement('style');
    style.id = 'coreum-ecg-alert-style';
    style.textContent = `
      #coreum-ecg-alert-panel {
        position: fixed;
        right: 14px;
        bottom: 14px;
        min-width: 260px;
        max-width: 320px;
        background: rgba(17, 20, 26, 0.96);
        color: #f5f7fa;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px;
        padding: 10px;
        box-shadow: 0 10px 28px rgba(0,0,0,0.28);
        font: 12px/1.35 Arial, sans-serif;
        z-index: ${CONFIG.ui.zIndex};
        user-select: none;
        backdrop-filter: blur(8px);
      }

      #coreum-ecg-alert-panel .cea-title {
        font-weight: 700;
        font-size: 13px;
        margin-bottom: 8px;
        opacity: 0.96;
      }

      #coreum-ecg-alert-panel .cea-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 8px;
      }

      #coreum-ecg-alert-panel button {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.10);
        background: #1b2430;
        color: #ffffff;
        border-radius: 999px;
        padding: 7px 12px;
        font: 12px Arial, sans-serif;
        cursor: pointer;
        transition: 0.15s ease;
      }

      #coreum-ecg-alert-panel button:hover {
        background: #243041;
        transform: translateY(-1px);
      }

      #coreum-ecg-alert-panel button.is-on {
        background: #163b25;
        border-color: rgba(92, 214, 143, 0.30);
        color: #dff7e8;
      }

      #coreum-ecg-alert-panel button.is-off {
        background: #3a1d23;
        border-color: rgba(255, 120, 120, 0.22);
        color: #ffdcdc;
      }
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    createStyles();

    const oldPanel = document.getElementById('coreum-ecg-alert-panel');
    if (oldPanel) oldPanel.remove();

    const panel = document.createElement('div');
    panel.id = 'coreum-ecg-alert-panel';
    panel.innerHTML = `
      <div class="cea-title">Alerta ECG WinCardio</div>

      <div class="cea-row">
        <button type="button" data-action="enable-audio">Ativar áudio</button>
        <button type="button" data-action="request-notif">Ativar notificações</button>
      </div>

      <div class="cea-row">
        <button type="button" data-toggle="sound">Som: -</button>
        <button type="button" data-toggle="notif">Notificações: -</button>
        <button type="button" data-toggle="keepalive">Keep Alive: -</button>
      </div>
    `;

    panel.addEventListener('click', async (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;

      const action = btn.getAttribute('data-action');
      const toggle = btn.getAttribute('data-toggle');

      if (action === 'enable-audio') {
        await enableAudioFromGesture();
        return;
      }

      if (action === 'request-notif') {
        await requestNotificationPermission();
        return;
      }

      if (toggle === 'sound') {
        state.settings.soundEnabled = !state.settings.soundEnabled;
        saveSettings();
        return;
      }

      if (toggle === 'notif') {
        state.settings.notificationsEnabled = !state.settings.notificationsEnabled;
        saveSettings();
        return;
      }

      if (toggle === 'keepalive') {
        state.settings.keepAliveEnabled = !state.settings.keepAliveEnabled;
        saveSettings();
        syncKeepAlive();
      }
    });

    document.body.appendChild(panel);
    state.ui.panel = panel;
    updatePanel();
  }

  function setToggleButtonState(selector, enabled, onText, offText) {
    const btn = state.ui.panel.querySelector(selector);
    if (!btn) return;

    btn.textContent = enabled ? onText : offText;
    btn.classList.toggle('is-on', enabled);
    btn.classList.toggle('is-off', !enabled);
  }

  function setActionButtonState(selector, enabled, activeText, inactiveText) {
    const btn = state.ui.panel.querySelector(selector);
    if (!btn) return;

    btn.textContent = enabled ? activeText : inactiveText;
    btn.classList.toggle('is-on', enabled);
    btn.classList.toggle('is-off', !enabled);
  }

  function updatePanel() {
    if (!state.ui.panel) return;

    const audioReady = getAudioStateLabel() === 'running';
    const notifGranted = getNotificationPermission() === 'granted';

    setActionButtonState(
      '[data-action="enable-audio"]',
      audioReady,
      'Áudio ativo',
      'Ativar áudio'
    );

    setActionButtonState(
      '[data-action="request-notif"]',
      notifGranted,
      'Notificações ativas',
      'Ativar notificações'
    );

    setToggleButtonState(
      '[data-toggle="sound"]',
      state.settings.soundEnabled,
      'Som: ON',
      'Som: OFF'
    );

    setToggleButtonState(
      '[data-toggle="notif"]',
      state.settings.notificationsEnabled,
      'Notificações: ON',
      'Notificações: OFF'
    );

    setToggleButtonState(
      '[data-toggle="keepalive"]',
      state.settings.keepAliveEnabled,
      'Keep Alive: ON',
      'Keep Alive: OFF'
    );
  }

  function attachLifecycleListeners() {
    document.addEventListener('visibilitychange', () => {
      updatePanel();
      if (!document.hidden) {
        scanQueue('visibilitychange', true);
      }
    });

    window.addEventListener('focus', () => {
      updatePanel();
      scanQueue('focus', true);
    });

    window.addEventListener('beforeunload', () => {
      stopScanningInfrastructure();
      stopAllOverdueLoops();
      stopKeepAlive();
    });
  }

  function init() {
    if (state.initialized) return;
    if (!document.body) return;

    state.settings = loadSettings();
    state.seenStore = loadSeenStore();
    state.sessionExpiringWarned = loadSessionArray(STORAGE_KEYS.sessionExpiring);
    state.sessionOverdueWarned = loadSessionArray(STORAGE_KEYS.sessionOverdue);

    createPanel();
    attachLifecycleListeners();
    startObserver();
    startIntervalScan();

    scanQueue('init', true);

    state.initialized = true;
    updatePanel();
    log('Initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
