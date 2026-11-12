import type { Bridge, Command, Snapshot } from './model';

interface TauriGlobal {
  core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

const listeners = new Set<(state: Snapshot) => void>();
let listening = false;

function ensureEventSubscription() {
  if (listening || !window.__TAURI__) return;
  listening = true;
  void window.__TAURI__.event.listen<Snapshot>('cat:state', event => {
    for (const listener of listeners) listener(event.payload);
  });
}

const bridge: Bridge = {
  command: (command: Command) => {
    if (!window.__TAURI__) return Promise.reject(Error('Tauri bridge unavailable'));
    return window.__TAURI__.core.invoke<Snapshot>('cat_command', { input: command });
  },
  subscribe: listener => {
    listeners.add(listener);
    ensureEventSubscription();
    return () => {
      listeners.delete(listener);
    };
  },
};

window.cat = bridge;

window.addEventListener('DOMContentLoaded', () => {
  ensureEventSubscription();
  if (window.__TAURI__) void window.__TAURI__.core.invoke('cat_ready');
}, { once: true });

// WKWebView on macOS may not initiate HTML5 dragstart on <button draggable="true">.
// Provide a pointer-driven fallback that dispatches standard DragEvents when native drag does not start.
let pointerDrag: { handle: HTMLElement; startX: number; startY: number; active: boolean; nativeStarted: boolean } | null = null;

document.addEventListener('dragstart', () => {
  if (pointerDrag) pointerDrag.nativeStarted = true;
}, true);

function dispatchSyntheticDrag(type: string, target: Element, dataTransfer: DataTransfer) {
  const evt = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
  target.dispatchEvent(evt);
}

document.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const handle = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-drag-device]');
  if (!handle) return;
  pointerDrag = { handle, startX: event.clientX, startY: event.clientY, active: false, nativeStarted: false };
});

document.addEventListener('pointermove', event => {
  if (!pointerDrag || pointerDrag.nativeStarted) return;
  const dx = event.clientX - pointerDrag.startX;
  const dy = event.clientY - pointerDrag.startY;
  if (!pointerDrag.active && Math.hypot(dx, dy) >= 5) {
    pointerDrag.active = true;
    const dt = new DataTransfer();
    dispatchSyntheticDrag('dragstart', pointerDrag.handle, dt);
  }
  if (pointerDrag.active) {
    event.preventDefault();
    const under = document.elementFromPoint(event.clientX, event.clientY);
    if (under) dispatchSyntheticDrag('dragover', under, new DataTransfer());
  }
});

function finishPointerDrag(event: PointerEvent, commit: boolean) {
  if (!pointerDrag) return;
  const current = pointerDrag;
  pointerDrag = null;
  if (!current.active || current.nativeStarted) return;
  const dt = new DataTransfer();
  if (commit) {
    const under = document.elementFromPoint(event.clientX, event.clientY);
    if (under) dispatchSyntheticDrag('drop', under, dt);
  }
  dispatchSyntheticDrag('dragend', current.handle, dt);
}

document.addEventListener('pointerup', event => finishPointerDrag(event, true));
document.addEventListener('pointercancel', event => finishPointerDrag(event, false));
