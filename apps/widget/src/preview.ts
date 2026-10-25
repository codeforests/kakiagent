/**
 * The dashboard's widget preview (FEAT-032 §5.3, D6): the real launcher and an open panel
 * in preview mode over a mock page in the site's background and font. Themed only by
 * `kaki-preview` messages from `window.parent`; the chat sends and fetches nothing.
 */
import type { WidgetConfigResponse, WidgetTheme } from '@kaki/contracts';
import { widgetTokens } from '@kaki/design-tokens/widget';
import { CHAT_ICON, LAUNCHER_CSS } from './launcher.css.js';
import { mountPanel } from './panel.js';
import { parsePreviewMessage, type PreviewMessage } from './preview-message.js';
import { hostSheetCss, hostStyle, resolved, tokenSheet } from './theme.js';

const PREVIEW_CSS = `
.pm{position:absolute;bottom:calc(var(--kaki-launcher-size) + 16px);right:0}
:host([data-position=left]) .pm{right:auto;left:0}`;

const T0 = '2026-01-01T09:00:00.000Z';
const sample = (botName: string) => {
  const conversationId = '00000000-0000-4000-8000-000000000001';
  const base = { conversationId, disclosure: null, notice: null, noticeKind: null, createdAt: T0 };
  return [
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000002',
      seq: 1,
      author: 'visitor' as const,
      body: 'Do you deliver on Sundays?',
      inReplyTo: null,
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000003',
      seq: 2,
      author: 'agent' as const,
      body: `Yes, we deliver every day. ${botName} can help you place an order.`,
      inReplyTo: '00000000-0000-4000-8000-000000000002',
    },
  ];
};

const host = document.createElement('kaki-agent');
const shadow = host.attachShadow({ mode: 'closed' });
const tokens = tokenSheet(shadow);
const adopt = (css: string) => {
  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
};
adopt(LAUNCHER_CSS + PREVIEW_CSS);
const panelMount = document.createElement('div');
panelMount.className = 'pm';
const launcher = document.createElement('button');
launcher.className = 'launcher';
launcher.type = 'button';
launcher.tabIndex = -1;
shadow.append(panelMount, launcher);
document.body.appendChild(host);

let panelCss = false;
function show(m: PreviewMessage) {
  const theme: WidgetTheme = m.theme;
  const r = resolved(
    theme,
    m.scheme ? { accent: null, font: null, radius: null, scheme: m.scheme } : null,
  );
  tokens.set(hostSheetCss(r));
  host.setAttribute('style', hostStyle(theme.position));
  host.dataset.position = theme.position;
  // The mock page: the scheme's widget surfaces, the site's background and font if known.
  const page = document.documentElement;
  page.setAttribute('style', widgetTokens[r.scheme]);
  if (m.site?.background) page.style.setProperty('--site-bg', m.site.background);
  if (m.site?.font) page.style.setProperty('--site-font', m.site.font);
  launcher.setAttribute('aria-label', `Chat with ${m.botName}`);
  launcher.replaceChildren();
  if (theme.logoUrl) {
    const img = document.createElement('img');
    img.src = theme.logoUrl;
    img.alt = '';
    launcher.append(img);
  } else launcher.innerHTML = CHAT_ICON;
  const config = {
    token: '',
    visitorId: '00000000-0000-4000-8000-000000000000',
    realtimeUrl: 'https://preview.invalid',
    panelUrl: 'https://preview.invalid',
    botName: m.botName,
    greeting: { en: m.greeting, zh: m.greeting },
    theme,
  } satisfies WidgetConfigResponse;
  mountPanel({
    shadow,
    mount: panelMount,
    config,
    apiUrl: 'https://preview.invalid',
    close: () => undefined,
    adopt: (css) => {
      if (!panelCss) adopt(css);
      panelCss = true;
    },
    preview: { messages: sample(m.botName) },
  });
}

show({
  type: 'kaki-preview',
  theme: { position: 'right', overrides: {}, detected: null, logoUrl: null },
  botName: 'Assistant',
  greeting: '',
});
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const m = parsePreviewMessage(e.data);
  if (m) show(m);
});
// Tells the dashboard the page is ready for its first message (no data in it).
window.parent.postMessage({ type: 'kaki-preview-ready' }, '*');
