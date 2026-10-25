/** Launcher styles and icon, shared by the loader and the preview: `--kaki-*` only (ADR-016). */
export const LAUNCHER_CSS = `
.launcher{width:var(--kaki-launcher-size);height:var(--kaki-launcher-size);border-radius:50%;border:0;
  background:var(--kaki-accent);color:var(--kaki-on-accent);cursor:pointer;display:flex;align-items:center;
  justify-content:center;box-shadow:0 4px 12px color-mix(in srgb,var(--kaki-text) 20%,transparent);padding:0;margin:0}
.launcher:focus-visible{outline:2px solid var(--kaki-accent);outline-offset:3px}
.launcher svg{width:26px;height:26px}
.launcher img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}
:host([data-position=left]) .panel{right:auto;left:0}
[hidden]{display:none!important}`;

export const CHAT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
