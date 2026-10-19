/**
 * Widget loader (ADR-016): ≤ 14 KB gz. Fetches config (origin-checked by the api),
 * renders the launcher into a closed Shadow DOM, and lazily imports the chat panel.
 * It must never break the host page: feature-detect, wrap everything in try/catch,
 * define no global except `window.__kaki` (NFR-14).
 *
 * Theme detection (CHN-14) is FEAT-032; the skeleton uses the default `--kaki-*` tokens.
 */
import type { WidgetConfigResponse } from '@kaki/contracts';
import { widgetTokens } from '@kaki/design-tokens/widget';
import type { PanelContext, PanelModule } from './types.js';

type KakiWindow = Window & { __kaki?: { v: number } };

const HOST_STYLE =
  'position:fixed!important;right:var(--kaki-edge-offset,20px)!important;bottom:var(--kaki-edge-offset,20px)!important;' +
  'z-index:2147483000!important;display:block!important;width:auto!important;height:auto!important;margin:0!important;padding:0!important;';

const LAUNCHER_CSS = `
:host{all:initial;${widgetTokens.light}}
.launcher{width:var(--kaki-launcher-size);height:var(--kaki-launcher-size);border-radius:50%;border:0;
  background:var(--kaki-accent);color:var(--kaki-on-accent);cursor:pointer;display:flex;align-items:center;
  justify-content:center;box-shadow:0 4px 12px color-mix(in srgb,var(--kaki-text) 20%,transparent);padding:0;margin:0}
.launcher:focus-visible{outline:2px solid var(--kaki-accent);outline-offset:3px}
.launcher svg{width:26px;height:26px}
[hidden]{display:none!important}`;

const CHAT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

function supported(): boolean {
  return (
    typeof Element !== 'undefined' &&
    'attachShadow' in Element.prototype &&
    typeof fetch === 'function' &&
    typeof Promise === 'function' &&
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function'
  );
}

function storedVisitorId(): string | null {
  try {
    return localStorage.getItem('kaki.vid');
  } catch {
    return null;
  }
}

function adopter(shadow: ShadowRoot) {
  return (css: string) => {
    if (
      'adoptedStyleSheets' in shadow &&
      typeof CSSStyleSheet === 'function' &&
      'replaceSync' in CSSStyleSheet.prototype
    ) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    } else {
      const style = document.createElement('style');
      style.textContent = css;
      shadow.appendChild(style);
    }
  };
}

function mount(config: WidgetConfigResponse, apiUrl: string) {
  try {
    localStorage.setItem('kaki.vid', config.visitorId);
  } catch {
    /* storage blocked: the visitor gets a new ID next visit */
  }
  const host = document.createElement('kaki-agent');
  host.setAttribute('style', HOST_STYLE);
  const shadow = host.attachShadow({ mode: 'closed' });
  const adopt = adopter(shadow);
  adopt(LAUNCHER_CSS);

  const panelMount = document.createElement('div');
  panelMount.hidden = true;
  const launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.type = 'button';
  launcher.setAttribute('aria-label', `Chat with ${config.botName}`);
  launcher.setAttribute('aria-expanded', 'false');
  launcher.innerHTML = CHAT_ICON;
  shadow.append(panelMount, launcher);
  document.body.appendChild(host);

  // Host scripts that rewrite our positioning get it restored (ADR-016 decision 2).
  new MutationObserver(() => {
    if (host.getAttribute('style') !== HOST_STYLE) host.setAttribute('style', HOST_STYLE);
  }).observe(host, { attributes: true, attributeFilter: ['style'] });

  let panel: Promise<{ focus(): void }> | null = null;
  const load = () => {
    if (!panel) {
      const ctx: PanelContext = { shadow, mount: panelMount, config, apiUrl, close, adopt };
      panel = (import(/* webpackIgnore: true */ config.panelUrl) as Promise<PanelModule>).then(
        (m) => m.mountPanel(ctx),
      );
    }
    return panel;
  };
  function close() {
    panelMount.hidden = true;
    launcher.hidden = false;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }
  launcher.addEventListener('click', () => {
    void load().then((p) => {
      panelMount.hidden = false;
      launcher.hidden = true;
      launcher.setAttribute('aria-expanded', 'true');
      p.focus();
    });
  });
  // Warm the panel chunk once the page is idle (ADR-016 decision 1).
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (idle) idle(() => void load().catch(() => (panel = null)));
}

(() => {
  try {
    const w = window as KakiWindow;
    if (w.__kaki || !supported()) return;
    const script = document.currentScript as HTMLScriptElement | null;
    const key = script?.dataset.key;
    if (!script || !key) return;
    w.__kaki = { v: 1 };
    const apiUrl = script.dataset.api || new URL(script.src).origin;
    const vid = storedVisitorId();
    fetch(`${apiUrl}/widget/v1/config?key=${encodeURIComponent(key)}`, {
      credentials: 'omit',
      headers: vid ? { 'x-kaki-visitor': vid } : {},
    })
      .then((r) => (r.ok ? (r.json() as Promise<WidgetConfigResponse>) : null))
      .then((config) => {
        // "Not here" (unknown key, wrong origin, not live): stay silent.
        if (!config) return;
        const start = () => mount(config, apiUrl);
        if (document.body) start();
        else document.addEventListener('DOMContentLoaded', start);
      })
      .catch(() => {});
  } catch {
    /* never throw into the host page */
  }
})();
