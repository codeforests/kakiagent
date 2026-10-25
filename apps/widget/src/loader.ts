/**
 * Widget loader (ADR-016): ≤ 14 KB gz. Fetches config (origin-checked by the api),
 * renders the launcher into a closed Shadow DOM, and lazily imports the chat panel.
 * It must never break the host page: feature-detect, wrap everything in try/catch,
 * define no global except `window.__kaki` (NFR-14).
 *
 * The look (CHN-14, FEAT-032 §5.2): the stored theme first, then the page's own look,
 * detected once the page is idle and followed between light and dark.
 */
import type { WidgetConfigResponse } from '@kaki/contracts';
import { detectTheme, type LiveTheme } from '@kaki/channels/theme';
import { CHAT_ICON, LAUNCHER_CSS } from './launcher.css.js';
import { followPage, hostSheetCss, hostStyle, resolved, tokenSheet } from './theme.js';
import type { PanelContext, PanelModule } from './types.js';

type KakiWindow = Window & { __kaki?: { v: number } };

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
  const { theme } = config;
  const style = hostStyle(theme.position);
  const host = document.createElement('kaki-agent');
  host.setAttribute('style', style);
  host.dataset.position = theme.position;
  const shadow = host.attachShadow({ mode: 'closed' });
  const adopt = adopter(shadow);
  adopt(LAUNCHER_CSS);
  // The token sheet stays first; swapping it re-renders nothing (§5.2).
  const tokens = tokenSheet(shadow);
  const apply = (live: LiveTheme | null) => tokens.set(hostSheetCss(resolved(theme, live)));
  apply(null);

  const panelMount = document.createElement('div');
  panelMount.hidden = true;
  const launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.type = 'button';
  launcher.setAttribute('aria-label', `Chat with ${config.botName}`);
  launcher.setAttribute('aria-expanded', 'false');
  if (theme.logoUrl) {
    const img = document.createElement('img');
    img.src = theme.logoUrl;
    img.alt = '';
    launcher.append(img);
  } else launcher.innerHTML = CHAT_ICON;
  shadow.append(panelMount, launcher);
  document.body.appendChild(host);

  // Host scripts that rewrite our positioning get it restored (ADR-016 decision 2).
  new MutationObserver(() => {
    if (host.getAttribute('style') !== style) host.setAttribute('style', style);
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
  // Once the page is idle: its look, then following it (unless the owner fixed the
  // scheme), and the panel chunk warmed (ADR-016 decision 1).
  const idle =
    (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ??
    ((cb: () => void) => setTimeout(cb, 0));
  idle(() => {
    try {
      apply(detectTheme(document, window));
      if (!theme.overrides.scheme) followPage(apply);
    } catch {
      /* the stored theme stays */
    }
    void load().catch(() => (panel = null));
  });
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
