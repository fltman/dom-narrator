(() => {
  if (window.__domNarratorLoaded) return;
  window.__domNarratorLoaded = true;

  const state = {
    panelOpen: false,
    picking: false,
    recording: false,
    sessionStart: null,
    events: [],
    elements: new Map(), // dn-id -> descriptor
    recognition: null,
    lang: "en-US",
    drag: null, // { id, el, handleEl, startX, startY, baseDx, baseDy, fromRect }
    handles: new Map(), // id -> { targetEl, handleEl }
    handleRafId: null,
    engine: "webspeech", // "webspeech" | "openai"
    apiKey: "",
    openaiModel: "gpt-realtime-whisper",
    openai: null, // { ws, ctx, stream, node, currentDelta }
    connStatus: "idle", // idle | connecting | open | closed | error
  };

  // Load persisted settings synchronously-ish on init.
  chrome.storage?.local.get(["dn_engine", "dn_apikey", "dn_lang", "dn_model"], (v) => {
    if (v.dn_engine) state.engine = v.dn_engine;
    if (v.dn_apikey) state.apiKey = v.dn_apikey;
    if (v.dn_lang) state.lang = v.dn_lang;
    if (v.dn_model) state.openaiModel = v.dn_model;
    if (panel) syncSettingsToPanel();
  });

  function saveSettings() {
    chrome.storage?.local.set({
      dn_engine: state.engine,
      dn_apikey: state.apiKey,
      dn_lang: state.lang,
      dn_model: state.openaiModel,
    });
  }

  // ---------- helpers ----------

  const now = () => (state.sessionStart ? Date.now() - state.sessionStart : 0);
  const fmtT = (ms) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  };

  function newId() {
    return "c-" + Math.random().toString(36).slice(2, 8);
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`${sel}#${CSS.escape(cur.id)}`);
        break;
      }
      const parent = cur.parentNode;
      if (parent) {
        const sibs = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function describe(el) {
    let id = el.dataset.dnId;
    if (!id) {
      id = newId();
      el.dataset.dnId = id;
    }
    const rect = el.getBoundingClientRect();
    const desc = {
      id,
      tag: el.tagName.toLowerCase(),
      domId: el.id || null,
      classes: Array.from(el.classList).filter((c) => c !== "dn-ignore"),
      text: (el.innerText || el.textContent || "").trim().slice(0, 80),
      selector: cssPath(el),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
    state.elements.set(id, desc);
    return desc;
  }

  function shortRef(desc) {
    let s = `<${desc.tag}`;
    if (desc.domId) s += `#${desc.domId}`;
    else if (desc.classes.length) s += `.${desc.classes[0]}`;
    if (desc.text) s += ` "${desc.text.slice(0, 30)}"`;
    s += ` :: ${desc.id}>`;
    return s;
  }

  function logEvent(ev) {
    ev.t = now();
    state.events.push(ev);
    renderLogEntry(ev);
    updateStatus();
  }

  function logInfo(text) {
    if (!logEl) return;
    const div = document.createElement("div");
    div.className = "dn-log-entry dn-info";
    div.innerHTML = `<span class="dn-t">[${fmtT(now())}]</span><span class="dn-text">${escapeHtml(text)}</span>`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------- panel ----------

  let panel, highlight, logEl, statusEl, recBtn;

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "dn-panel";
    panel.className = "dn-ignore";
    panel.innerHTML = `
      <div class="dn-header" id="dn-drag-header">
        <span class="dn-title">DOM Narrator</span>
        <button class="dn-close" title="Hide panel">x</button>
      </div>
      <div class="dn-body">
        <div class="dn-row">
          <button class="dn-btn" id="dn-rec">Start mic</button>
        </div>
        <div class="dn-row">
          <select class="dn-engine" id="dn-engine" title="Transcription engine">
            <option value="openai">OpenAI Realtime</option>
            <option value="webspeech">Web Speech (free)</option>
          </select>
          <select class="dn-lang" id="dn-lang" title="Language hint">
            <option value="en-US">English (US)</option>
            <option value="en-GB">English (UK)</option>
            <option value="sv-SE">Svenska</option>
            <option value="de-DE">Deutsch</option>
            <option value="es-ES">Español</option>
            <option value="fr-FR">Français</option>
          </select>
        </div>
        <div class="dn-row dn-openai-only">
          <input type="password" class="dn-input" id="dn-apikey" placeholder="OpenAI API key (sk-...)" autocomplete="off" />
        </div>
        <div class="dn-row">
          <button class="dn-btn" id="dn-clear">Clear</button>
        </div>
        <div class="dn-status" id="dn-status">Idle</div>
        <div class="dn-log" id="dn-log"></div>
        <div class="dn-credit">
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>
          · Anders Bjarby
        </div>
        <div class="dn-refined" id="dn-refined" style="display:none">
          <div class="dn-refined-loading" id="dn-refined-loading" style="display:none">
            <div class="dn-spinner"></div>
            <span class="dn-refined-loading-text">Refining prompt</span>
          </div>
          <div class="dn-row" id="dn-refined-actions" style="display:none">
            <button class="dn-btn" id="dn-copy">Copy prompt</button>
          </div>
          <textarea class="dn-refined-text" id="dn-refined-text" readonly style="display:none"></textarea>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    highlight = document.createElement("div");
    highlight.id = "dn-highlight";
    highlight.className = "dn-ignore";
    highlight.innerHTML = `<div class="dn-tag"></div>`;
    document.documentElement.appendChild(highlight);

    logEl = panel.querySelector("#dn-log");
    statusEl = panel.querySelector("#dn-status");
    recBtn = panel.querySelector("#dn-rec");

    panel.querySelector(".dn-close").addEventListener("click", togglePanel);
    recBtn.addEventListener("click", toggleRecording);
    panel.querySelector("#dn-clear").addEventListener("click", clearSession);
    panel.querySelector("#dn-lang").addEventListener("change", (e) => {
      state.lang = e.target.value;
      saveSettings();
      if (state.recording) {
        stopRecording();
        startRecording();
      }
    });
    panel.querySelector("#dn-engine").addEventListener("change", (e) => {
      state.engine = e.target.value;
      saveSettings();
      syncSettingsToPanel();
      if (state.recording) {
        stopRecording();
        startRecording();
      }
    });
    panel.querySelector("#dn-apikey").addEventListener("change", (e) => {
      state.apiKey = e.target.value.trim();
      saveSettings();
    });
    panel.querySelector("#dn-copy").addEventListener("click", copyRefined);

    syncSettingsToPanel();
    makePanelDraggable();
  }

  function syncSettingsToPanel() {
    if (!panel) return;
    panel.querySelector("#dn-engine").value = state.engine;
    panel.querySelector("#dn-lang").value = state.lang;
    panel.querySelector("#dn-apikey").value = state.apiKey;
    panel.querySelectorAll(".dn-openai-only").forEach((row) => {
      row.style.display = state.engine === "openai" ? "" : "none";
    });
  }

  function makePanelDraggable() {
    const header = panel.querySelector("#dn-drag-header");
    let dx = 0, dy = 0, dragging = false;
    header.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = `${e.clientX - dx}px`;
      panel.style.top = `${e.clientY - dy}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => { dragging = false; });
  }

  function togglePanel() {
    if (!panel) buildPanel();
    state.panelOpen = !state.panelOpen;
    panel.classList.toggle("open", state.panelOpen);
    if (state.panelOpen && !state.sessionStart) {
      state.sessionStart = Date.now();
    }
    updateStatus();
  }

  function updateStatus() {
    if (!statusEl) return;
    const speech = state.events.filter((e) => e.type === "speech").length;
    const sels = state.events.filter((e) => e.type === "select").length;
    const drags = state.events.filter((e) => e.type === "drag").length;
    const parts = [];
    if (state.picking) parts.push("PICKING");
    if (state.recording) parts.push(`REC[${state.engine}:${state.connStatus}]`);
    parts.push(`${sels} sel · ${drags} drag · ${speech} speech`);
    statusEl.textContent = parts.join(" · ");
  }

  function renderLogEntry(ev) {
    if (!logEl) return;
    const div = document.createElement("div");
    div.className = `dn-log-entry dn-${ev.type}`;
    const t = `<span class="dn-t">[${fmtT(ev.t)}]</span>`;
    let txt = "";
    if (ev.type === "speech") txt = `<span class="dn-text">"${escapeHtml(ev.text)}"</span>`;
    else if (ev.type === "select") {
      const d = state.elements.get(ev.id);
      txt = `<span class="dn-text">SELECT ${escapeHtml(shortRef(d))}</span>`;
    } else if (ev.type === "drag") {
      txt = `<span class="dn-text">DRAG ${escapeHtml(ev.id)} Δ(${ev.delta.dx > 0 ? "+" : ""}${ev.delta.dx}, ${ev.delta.dy > 0 ? "+" : ""}${ev.delta.dy})</span>`;
    } else if (ev.type === "drop-on") {
      const target = state.elements.get(ev.targetId);
      txt = `<span class="dn-text">DROP ${escapeHtml(ev.id)} ONTO ${escapeHtml(shortRef(target))}</span>`;
    }
    div.innerHTML = t + txt;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // ---------- picker ----------

  function togglePick() {
    state.picking ? stopPick() : startPick();
  }

  function startPick() {
    state.picking = true;
    document.addEventListener("mousemove", onPickHover, true);
    document.addEventListener("click", onPickClick, true);
    document.addEventListener("keydown", onPickEscape, true);
    updateStatus();
  }

  function stopPick() {
    state.picking = false;
    if (highlight) highlight.classList.remove("active");
    document.removeEventListener("mousemove", onPickHover, true);
    document.removeEventListener("click", onPickClick, true);
    document.removeEventListener("keydown", onPickEscape, true);
    updateStatus();
  }

  function isOwnUi(el) {
    if (!el || !el.closest) return false;
    return !!(
      el.closest("#dn-panel") ||
      el.closest("#dn-highlight") ||
      el.closest("#dn-overlay") ||
      el.closest(".dn-handle") ||
      el.closest(".dn-ignore")
    );
  }

  function onPickHover(e) {
    const el = e.target;
    if (!el || isOwnUi(el)) {
      highlight.classList.remove("active");
      return;
    }
    const r = el.getBoundingClientRect();
    highlight.style.left = `${r.left}px`;
    highlight.style.top = `${r.top}px`;
    highlight.style.width = `${r.width}px`;
    highlight.style.height = `${r.height}px`;
    highlight.classList.add("active");
    const tag = highlight.querySelector(".dn-tag");
    tag.textContent = `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.classList[0] ? "." + el.classList[0] : ""}`;
  }

  function onPickClick(e) {
    const el = e.target;
    if (!el || isOwnUi(el)) return;
    e.preventDefault();
    e.stopPropagation();
    selectElement(el);
    // While recording, stay in pick mode so the user can keep selecting things.
    // Manual pick (no recording) exits after one selection — matches devtools behavior.
    if (!state.recording) stopPick();
  }

  function onPickEscape(e) {
    if (e.key === "Escape") stopPick();
  }

  function selectElement(el) {
    const desc = describe(el);
    el.dataset.dnSelected = "true";
    el.dataset.dnId = desc.id;
    createHandle(desc.id, el);
    logEvent({ type: "select", id: desc.id });
  }

  function deselectElement(id) {
    const el = document.querySelector(`[data-dn-id="${id}"]`);
    if (el) {
      el.removeAttribute("data-dn-selected");
      el.removeAttribute("data-dn-dragging");
      el.style.transform = "";
    }
    const h = state.handles.get(id);
    if (h) {
      h.handleEl.remove();
      state.handles.delete(id);
    }
    if (state.handles.size === 0 && state.handleRafId) {
      cancelAnimationFrame(state.handleRafId);
      state.handleRafId = null;
    }
  }

  // ---------- drag (via floating handle) ----------

  function ensureOverlay() {
    let overlay = document.getElementById("dn-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "dn-overlay";
      overlay.className = "dn-ignore";
      document.documentElement.appendChild(overlay);
    }
    return overlay;
  }

  function createHandle(id, targetEl) {
    if (state.handles.has(id)) return state.handles.get(id).handleEl;
    const overlay = ensureOverlay();
    const h = document.createElement("div");
    h.className = "dn-handle dn-ignore";
    h.dataset.handleFor = id;
    h.innerHTML = `<span class="dn-grip">⋮⋮</span><span class="dn-handle-label">${escapeHtml(id)}</span><button class="dn-handle-close" title="Deselect">×</button>`;
    overlay.appendChild(h);
    h.addEventListener("mousedown", (e) => onHandleMouseDown(e, id, targetEl, h));
    h.querySelector(".dn-handle-close").addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });
    h.querySelector(".dn-handle-close").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      deselectElement(id);
    });
    state.handles.set(id, { targetEl, handleEl: h });
    if (!state.handleRafId) tickHandles();
    return h;
  }

  function tickHandles() {
    state.handles.forEach(({ targetEl, handleEl }, id) => {
      if (!targetEl.isConnected) {
        deselectElement(id);
        return;
      }
      const r = targetEl.getBoundingClientRect();
      handleEl.style.left = `${Math.max(0, r.left)}px`;
      handleEl.style.top = `${Math.max(0, r.top - 26)}px`;
    });
    if (state.handles.size > 0) {
      state.handleRafId = requestAnimationFrame(tickHandles);
    } else {
      state.handleRafId = null;
    }
  }

  function onHandleMouseDown(e, id, targetEl, handleEl) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const desc = state.elements.get(id) || describe(targetEl);
    const rect = targetEl.getBoundingClientRect();
    const existingTransform = targetEl.style.transform || "";
    const match = existingTransform.match(/translate\((-?\d+\.?\d*)px,\s*(-?\d+\.?\d*)px\)/);
    const baseDx = match ? parseFloat(match[1]) : 0;
    const baseDy = match ? parseFloat(match[2]) : 0;

    state.drag = {
      id,
      el: targetEl,
      handleEl,
      startX: e.clientX,
      startY: e.clientY,
      baseDx,
      baseDy,
      fromRect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
    targetEl.dataset.dnDragging = "true";
    handleEl.classList.add("dragging");
    window.addEventListener("mousemove", onDragMove, true);
    window.addEventListener("mouseup", onDragEnd, true);
  }

  function onDragMove(e) {
    if (!state.drag) return;
    const d = state.drag;
    const dx = d.baseDx + (e.clientX - d.startX);
    const dy = d.baseDy + (e.clientY - d.startY);
    d.el.style.transform = `translate(${dx}px, ${dy}px)`;
    d.lastDx = dx;
    d.lastDy = dy;
  }

  function onDragEnd(e) {
    if (!state.drag) return;
    const d = state.drag;
    window.removeEventListener("mousemove", onDragMove, true);
    window.removeEventListener("mouseup", onDragEnd, true);
    d.el.removeAttribute("data-dn-dragging");
    if (d.handleEl) d.handleEl.classList.remove("dragging");

    const toRect = d.el.getBoundingClientRect();
    const toPoint = { x: Math.round(toRect.x), y: Math.round(toRect.y) };
    const delta = { dx: Math.round((d.lastDx ?? d.baseDx) - d.baseDx), dy: Math.round((d.lastDy ?? d.baseDy) - d.baseDy) };

    // Find drop target: topmost element under cursor that isn't the dragged one or our UI.
    // Hide both the dragged element AND every handle so they don't intercept the hit-test.
    const dragged = d.el;
    const overlay = document.getElementById("dn-overlay");
    const prevDraggedPE = dragged.style.pointerEvents;
    const prevOverlayDisplay = overlay ? overlay.style.display : null;
    dragged.style.pointerEvents = "none";
    if (overlay) overlay.style.display = "none";
    const under = document.elementFromPoint(e.clientX, e.clientY);
    dragged.style.pointerEvents = prevDraggedPE;
    if (overlay) overlay.style.display = prevOverlayDisplay || "";

    let dropTarget = null;
    if (under && !isOwnUi(under) && under !== dragged && !dragged.contains(under)) {
      dropTarget = describe(under);
    }

    logEvent({
      type: "drag",
      id: d.id,
      from: { x: d.fromRect.x, y: d.fromRect.y },
      to: toPoint,
      delta,
    });
    if (dropTarget) {
      logEvent({ type: "drop-on", id: d.id, targetId: dropTarget.id, point: { x: e.clientX, y: e.clientY } });
    }
    state.drag = null;
  }

  // ---------- speech (dispatcher) ----------

  function toggleRecording() {
    state.recording ? stopRecording() : startRecording();
  }

  function startRecording() {
    resetSession();
    if (state.engine === "openai") startOpenAI();
    else startWebSpeech();
    if (!state.picking) startPick();
  }

  function stopRecording() {
    if (state.engine === "openai") stopOpenAI();
    else stopWebSpeech();
    if (state.picking) stopPick();
    state.recording = false;
    if (recBtn) {
      recBtn.classList.remove("recording");
      recBtn.textContent = "Start mic";
    }
    state.connStatus = "idle";
    updateStatus();
    // Auto-refine on stop if we have something worth refining and a key on file.
    if (state.apiKey && state.events.length > 0) {
      refinePrompt({ silent: true });
    }
  }

  function markRecordingActive() {
    state.recording = true;
    if (recBtn) {
      recBtn.classList.add("recording");
      recBtn.textContent = "Stop mic";
    }
    updateStatus();
  }

  // ---------- Web Speech (fallback) ----------

  function startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert("Web Speech not supported here — switch engine to OpenAI Realtime.");
      return;
    }
    const r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.lang = state.lang;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript.trim();
          if (text) logEvent({ type: "speech", text, source: "webspeech" });
        }
      }
    };
    r.onerror = (e) => {
      console.warn("[DOM Narrator] webspeech error", e);
      if (e.error === "no-speech") return;
      if (e.error === "not-allowed") {
        alert("Microphone access denied.");
        stopRecording();
      }
    };
    r.onend = () => {
      if (state.recording && state.engine === "webspeech") {
        try { r.start(); } catch (_) {}
      }
    };
    try { r.start(); } catch (e) { console.warn(e); return; }
    state.recognition = r;
    state.connStatus = "open";
    markRecordingActive();
  }

  function stopWebSpeech() {
    if (state.recognition) {
      try { state.recognition.stop(); } catch (_) {}
      state.recognition = null;
    }
  }

  // ---------- OpenAI Realtime (transcription session) ----------

  async function startOpenAI() {
    if (!state.apiKey) {
      alert("Set your OpenAI API key in the panel first.");
      return;
    }
    state.connStatus = "connecting";
    updateStatus();

    // 1. Mint an ephemeral client_secret via the GA endpoint.
    // /v1/realtime/sessions (beta) was removed May 2026.
    // Using gpt-4o-transcribe because it supports server-side VAD —
    // pauses in speech automatically commit and emit a finalized transcript.
    const transcriptionModel = "gpt-4o-transcribe";
    let ephemeral;
    try {
      const sessRes = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds: 600 },
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: {
                  model: transcriptionModel,
                  language: state.lang.split("-")[0],
                },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  silence_duration_ms: 500,
                },
              },
            },
          },
        }),
      });
      if (!sessRes.ok) {
        const t = await sessRes.text();
        throw new Error(`HTTP ${sessRes.status}: ${t.slice(0, 400)}`);
      }
      const sessJson = await sessRes.json();
      ephemeral = sessJson.client_secret?.value || sessJson.value || sessJson.client_secret;
      if (!ephemeral) throw new Error("response missing client_secret.value");
      logInfo(`OpenAI: ephemeral minted (model=${transcriptionModel})`);
    } catch (e) {
      console.warn("[DOM Narrator] client_secrets mint failed", e);
      logInfo("OpenAI mint failed: " + e.message);
      alert("OpenAI mint failed:\n" + e.message);
      state.connStatus = "error"; updateStatus();
      return;
    }

    // 2. Set up audio capture
    let stream, ctx, node, ws;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      alert("Microphone permission denied.");
      state.connStatus = "error"; updateStatus();
      return;
    }
    try {
      ctx = new AudioContext({ sampleRate: 24000 });
      const workletUrl = chrome.runtime.getURL("pcm-worklet.js");
      await ctx.audioWorklet.addModule(workletUrl);
      node = new AudioWorkletNode(ctx, "pcm-worklet");
      const src = ctx.createMediaStreamSource(stream);
      src.connect(node);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink).connect(ctx.destination);
    } catch (e) {
      console.warn("[DOM Narrator] audio init failed", e);
      stream.getTracks().forEach((t) => t.stop());
      state.connStatus = "error"; updateStatus();
      return;
    }

    // 3. Connect WebSocket using the ephemeral as the auth token.
    // GA endpoint — no ?intent, no beta subprotocol. Session config is
    // already bound to the ephemeral from the client_secrets mint above.
    const url = "wss://api.openai.com/v1/realtime";
    try {
      ws = new WebSocket(url, [
        "realtime",
        "openai-insecure-api-key." + ephemeral,
      ]);
    } catch (e) {
      console.warn("[DOM Narrator] ws ctor failed", e);
      tearDownOpenAI(stream, ctx);
      state.connStatus = "error"; updateStatus();
      return;
    }

    ws.onopen = () => {
      state.connStatus = "open";
      updateStatus();
      logInfo("OpenAI: WebSocket open, streaming audio (VAD on)");
      node.port.onmessage = (ev) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const b64 = int16BufferToBase64(ev.data);
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      };
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      console.log("[DOM Narrator] WS", msg.type, msg);
      switch (msg.type) {
        case "conversation.item.input_audio_transcription.delta":
          state.openai.currentDelta = (state.openai.currentDelta || "") + (msg.delta || "");
          break;
        case "conversation.item.input_audio_transcription.completed": {
          const text = (msg.transcript || state.openai.currentDelta || "").trim();
          state.openai.currentDelta = "";
          if (text) logEvent({ type: "speech", text, source: "openai" });
          break;
        }
        case "session.created":
          logInfo("OpenAI: session.created");
          break;
        case "session.updated":
          logInfo("OpenAI: session.updated (transcription active)");
          break;
        case "input_audio_buffer.speech_started":
          logInfo("OpenAI: speech detected by VAD");
          break;
        case "input_audio_buffer.speech_stopped":
          logInfo("OpenAI: speech ended");
          break;
        case "error":
          logInfo("OpenAI ERROR: " + (msg.error?.message || JSON.stringify(msg.error || msg)));
          console.warn("[DOM Narrator] OpenAI error event", msg);
          break;
      }
    };

    ws.onerror = (e) => {
      console.warn("[DOM Narrator] ws error", e);
      logInfo("OpenAI: WebSocket error (see console)");
      state.connStatus = "error";
      updateStatus();
    };
    ws.onclose = (e) => {
      console.log("[DOM Narrator] ws closed", e.code, e.reason);
      logInfo(`OpenAI: closed (code=${e.code}${e.reason ? ", " + e.reason : ""})`);
      if (state.recording && state.engine === "openai") {
        state.connStatus = "closed";
        updateStatus();
      }
    };

    state.openai = { ws, ctx, stream, node, currentDelta: "" };
    markRecordingActive();
  }

  function stopOpenAI() {
    if (!state.openai) return;
    const { ws, ctx, stream, node } = state.openai;
    try { node && (node.port.onmessage = null); } catch (_) {}
    try { ws && ws.close(); } catch (_) {}
    tearDownOpenAI(stream, ctx);
    state.openai = null;
  }

  function tearDownOpenAI(stream, ctx) {
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { ctx && ctx.close(); } catch (_) {}
  }

  function int16BufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // ---------- session / export ----------

  function resetSession() {
    state.events = [];
    state.sessionStart = Date.now();
    Array.from(state.handles.keys()).forEach(deselectElement);
    state.elements.clear();
    if (logEl) logEl.innerHTML = "";
    const refined = panel?.querySelector("#dn-refined");
    if (refined) refined.style.display = "none";
    updateStatus();
  }

  function clearSession() {
    if (!confirm("Clear all logged events and deselect everything?")) return;
    stopRecording();
    resetSession();
  }

  function buildExport() {
    return {
      url: location.href,
      title: document.title,
      sessionStart: new Date(state.sessionStart).toISOString(),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      elements: Object.fromEntries(state.elements),
      events: state.events,
    };
  }

  function buildTranscript(data) {
    const lines = [];
    lines.push(`# DOM Narrator session`);
    lines.push(`URL: ${data.url}`);
    lines.push(`Title: ${data.title}`);
    lines.push(`Start: ${data.sessionStart}`);
    lines.push(`Viewport: ${data.viewport.w}x${data.viewport.h}`);
    lines.push("");
    lines.push(`## Elements referenced`);
    for (const [id, d] of Object.entries(data.elements)) {
      lines.push(`- ${id}: <${d.tag}${d.domId ? "#" + d.domId : ""}${d.classes.length ? "." + d.classes.join(".") : ""}> "${d.text}"`);
      lines.push(`    selector: ${d.selector}`);
      lines.push(`    rect: x=${d.rect.x} y=${d.rect.y} w=${d.rect.w} h=${d.rect.h}`);
    }
    lines.push("");
    lines.push(`## Timeline`);
    for (const ev of data.events) {
      const t = fmtT(ev.t);
      if (ev.type === "speech") {
        lines.push(`[${t}] SAID: "${ev.text}"`);
      } else if (ev.type === "select") {
        const d = data.elements[ev.id];
        lines.push(`[${t}] SELECTED ${ev.id}  <${d.tag}${d.domId ? "#" + d.domId : ""}> "${d.text.slice(0, 40)}"`);
      } else if (ev.type === "drag") {
        lines.push(`[${t}] DRAGGED ${ev.id}  from (${ev.from.x},${ev.from.y}) to (${ev.to.x},${ev.to.y})  Δ(${ev.delta.dx},${ev.delta.dy})`);
      } else if (ev.type === "drop-on") {
        const tgt = data.elements[ev.targetId];
        lines.push(`[${t}] DROPPED ${ev.id} ONTO ${ev.targetId}  <${tgt.tag}${tgt.domId ? "#" + tgt.domId : ""}> "${tgt.text.slice(0, 40)}"`);
      }
    }
    return lines.join("\n");
  }

  function download(name, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const data = buildExport();
    download(`dom-narrator-${Date.now()}.json`, "application/json", JSON.stringify(data, null, 2));
  }

  function exportTranscript() {
    const data = buildExport();
    download(`dom-narrator-${Date.now()}.txt`, "text/plain", buildTranscript(data));
  }

  // ---------- refine ----------

  const REFINE_SYSTEM = `You convert a noisy, possibly multilingual spoken UI-edit session transcript into a clear, actionable prompt for an AI coding assistant (e.g. Claude Code).

# Input shape

You receive a session log with two sections:

## Elements
A table of DOM elements the user pointed at. Each has:
- internal ID (e.g. c-abc123)
- tag, dom id, classes, CSS selector
- bounding rect (viewport coordinates)

## Timeline
Chronological events with timestamps [m:ss]:
- SAID "..." — transcribed speech (may be English, Swedish, German, mixed, etc.)
- SELECTED <element> — user picked an element via the inspector
- DRAGGED <element> from (x,y) to (x,y) — user moved an element
- DROPPED <element> ONTO <other element>

# Critical rules

## 1. Temporal demonstrative resolution

Demonstratives in speech ("this", "that", "here", "there", "it", "den här", "den", "hit", "där", "this one", "den där") DO NOT refer to whichever element seems plausible from context alone. They refer to whichever element was SELECTED, DRAGGED, or DROPPED in the timeline within ~5 seconds of the utterance.

Resolution heuristic:
- An object demonstrative ("this button", "den här knappen") immediately AFTER a SELECT refers to the just-selected element.
- A location demonstrative ("here", "there", "hit", "där") right after a SELECT refers to the just-selected element's *location*, not the element itself.
- A subject pronoun ("it", "den") refers to the most recently mentioned/selected element BEFORE the current one if a different element was just selected.

Worked example:
\`\`\`
[0:08] SELECTED button.A "Start"
[0:11] SAID "I want to take this button"     → "this button" = button.A
[0:13] SELECTED button.B "Choose"
[0:15] SAID "and move it here"               → "it" = button.A (previous subject), "here" = button.B's location
\`\`\`
So the action is: move button.A to where button.B currently is.

## 2. Contradictions and changes of mind

If the user says "actually no", "wait", "eller vänta", "scrap that", "instead", "nej förresten", etc., DROP earlier instructions and follow only the latest.

## 3. Garbled or incomplete utterances

Speech-to-text drops words, mishears, and cuts off mid-thought. This is normal — DO NOT treat it as ambiguity. Use the surrounding context (selected elements, drags, the rest of the speech) to infer the most likely intent and COMMIT to it. Incomplete trailing fragments like "Det var ett coolt" can be ignored entirely.

## 4. Output format — be decisive

You are NOT a clarification bot. You are a translator from messy speech to a clean prompt. Always pick the single most likely interpretation and output it as a direct instruction. Do NOT list alternatives. Do NOT ask the user to clarify. Do NOT hedge.

Output:

\`\`\`
## Goal
<one sentence describing what to build/change>

## Changes
- <change 1 — refer to elements by CSS selector, not c-xxxxxx ID>
- <change 2>
\`\`\`

The ONLY time you may flag ambiguity is if you genuinely cannot identify ANY plausible action from the entire session (e.g. zero coherent words and zero element interactions). In that single case output:

\`\`\`
## Nothing actionable
<one sentence on why>
\`\`\`

Otherwise: commit. Pick the best interpretation. Move on.

# Style

- Always output in English (the coding assistant's language), but quote user phrases verbatim from the original language when needed for clarity.
- Reference elements by CSS selector or a short descriptor like "the Start button (button#start-countdown-btn)", never by the internal c-xxxxxx ID.
- For positions, prefer relational language ("at the location of #foo", "inside .card", "at the bottom of #hero") over raw pixel coordinates. Only mention coordinates when no relational anchor exists.
- Terse. No preamble. No closing summary. Output only the structured prompt.`;

  async function refinePrompt({ silent = false } = {}) {
    if (!state.apiKey) {
      if (!silent) alert("Need an OpenAI API key to refine. Add it in the panel.");
      return;
    }
    if (state.events.length === 0) {
      if (!silent) alert("Nothing to refine yet — log some speech and selections first.");
      return;
    }

    showRefining();

    const data = buildExport();
    const transcript = buildTranscript(data);

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          max_completion_tokens: 800,
          messages: [
            { role: "system", content: REFINE_SYSTEM },
            { role: "user", content: transcript },
          ],
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 300)}`);
      }
      const json = await res.json();
      const text = json.choices?.[0]?.message?.content?.trim() || "(empty response)";
      showRefined(text);
    } catch (e) {
      console.error("[DOM Narrator] refine failed", e);
      logInfo("Refine failed: " + e.message);
      hideRefining();
      if (!silent) alert("Refine failed: " + e.message);
    }
  }

  function showRefining() {
    if (!panel) return;
    panel.querySelector("#dn-refined").style.display = "";
    panel.querySelector("#dn-refined-loading").style.display = "";
    panel.querySelector("#dn-refined-actions").style.display = "none";
    panel.querySelector("#dn-refined-text").style.display = "none";
  }

  function hideRefining() {
    if (!panel) return;
    panel.querySelector("#dn-refined-loading").style.display = "none";
  }

  function showRefined(text) {
    if (!panel) return;
    const ta = panel.querySelector("#dn-refined-text");
    ta.value = text;
    panel.querySelector("#dn-refined").style.display = "";
    panel.querySelector("#dn-refined-loading").style.display = "none";
    panel.querySelector("#dn-refined-actions").style.display = "";
    ta.style.display = "";
  }

  async function copyRefined() {
    const ta = panel.querySelector("#dn-refined-text");
    try {
      await navigator.clipboard.writeText(ta.value);
      const btn = panel.querySelector("#dn-copy");
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch (_) {
      ta.select();
      document.execCommand("copy");
    }
  }

  // ---------- message bus ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "dn:toggle-panel") {
      togglePanel();
      sendResponse({ ok: true });
    }
    return true;
  });
})();
