# DOM Narrator

A Chrome extension for **showing, not telling** an AI coding assistant what to change on a webpage.

You click elements on the page, drag them with a handle, and narrate what you want — all in one flow. The extension builds a grounded, timestamped transcript that resolves "this", "that", and "here" against actual DOM selections. It then refines that messy session into a clean, copy-pastable prompt for Claude Code (or any AI coding assistant).

> CC BY 4.0 — Anders Bjarby

---

## Why

LLMs are great at code but bad at pronouns. *"Move this button next to that thing and make it green"* is unambiguous to a human looking at the page, but impossible for an LLM staring at HTML. DOM Narrator solves the grounding problem by recording **what you pointed at** alongside **what you said** — every "this" gets a stable CSS selector attached.

---

## Install

1. Clone the repo: `git clone https://github.com/fltman/dom-narrator.git`
2. Open Chrome → `chrome://extensions`
3. Toggle **Developer mode** (top-right)
4. Click **Load unpacked** → select the cloned folder
5. Pin the extension to the toolbar

---

## Use

1. Open any webpage you want to redesign.
2. Click the **DOM Narrator** toolbar icon → the panel appears bottom-right (draggable by its title bar).
3. (Optional) Paste an OpenAI API key into the panel — needed for OpenAI Realtime transcription and for prompt refinement.
4. Click **Start mic**:
   - The mic starts recording (Web Speech by default, or OpenAI Realtime if selected).
   - Pick mode auto-engages — *every click on the page selects an element*.
5. Talk naturally. Click elements as you reference them. Drag the green handle above any selected element to reposition it.
6. Click **Stop mic** → the session auto-refines into a clean prompt.
7. Click **Copy prompt** → paste into Claude Code.

Each Start mic press wipes the previous session and starts fresh.

---

## What gets logged

| Event | What it records |
|---|---|
| `speech` | Finalized transcript chunk with timestamp |
| `select` | Element clicked in pick mode (CSS selector, tag, classes, text, bounding rect) |
| `drag` | From/to viewport coordinates + delta |
| `drop-on` | Which element was under the cursor when the drag ended |

All events go into a single chronological timeline. The refiner uses event ordering to bind demonstratives — *"and move it here"* said two seconds after selecting `<button.cta>` means *"here"* = that button's location.

---

## Configuration

In the panel:

- **Engine**: `Web Speech (free)` or `OpenAI Realtime` (better Swedish/multilingual support, requires API key)
- **Language**: hint for the recognizer (en-US, sv-SE, de-DE, etc.)
- **API key**: stored in `chrome.storage.local`, only sent to OpenAI

---

## Technical notes

### Transcription

- **Web Speech** path uses the browser's built-in `SpeechRecognition` — free, no key, decent for English, weaker for Swedish.
- **OpenAI Realtime** path uses the GA (post-May-2026) flow:
  - `POST /v1/realtime/client_secrets` to mint a short-lived ephemeral token
  - `wss://api.openai.com/v1/realtime` with subprotocols `["realtime", "openai-insecure-api-key.<TOKEN>"]`
  - Model: `gpt-4o-transcribe` with `server_vad` turn detection so pauses auto-commit
  - Audio: PCM16 mono at 24 kHz, captured via `AudioContext({ sampleRate: 24000 })` + `AudioWorklet`

### Refinement

- Model: `gpt-5.5` via chat completions
- `max_completion_tokens: 800`, no `temperature` (GPT-5.x reasoning models reject it)
- System prompt explicitly instructs the model to:
  - Resolve demonstratives by scanning ±5s of the timeline
  - Distinguish object pronouns ("it") from location demonstratives ("here")
  - Drop earlier instructions when the user contradicts themselves
  - Commit to a single best interpretation — never list alternatives
  - Ignore trailing garbled fragments

### Drag handle

Selected elements are not mutated (no injected `position: relative`). A separate floating handle div is positioned via `requestAnimationFrame` to follow the element's `getBoundingClientRect()`. The drag applies a `transform: translate()` to the element.

### Element identity

Each picked element gets a `data-dn-id="c-xxxxxx"` attribute + a generated CSS path (`tag:nth-of-type(n) > ...`). The refiner is instructed to use the CSS selector, never the internal ID.

---

## Limitations

- Web Speech is Google-backed and has known quality issues for non-English; OpenAI Realtime is much better.
- Element IDs are per-session; reloading the page invalidates them.
- Page navigation kills the recording (no offscreen document yet).
- No icon set — toolbar shows the default puzzle piece. PRs welcome.

---

## License

CC BY 4.0 — Anders Bjarby

You may use, modify, and redistribute, including commercially, as long as you give appropriate credit. See [LICENSE](LICENSE) or [creativecommons.org/licenses/by/4.0](https://creativecommons.org/licenses/by/4.0/).
