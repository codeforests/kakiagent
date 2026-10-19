/** Panel styles: `--kaki-*` variables only (ADR-016, design.md §4.9). */
export const PANEL_CSS = `
.panel{position:absolute;right:0;bottom:0;width:var(--kaki-panel-width);height:min(var(--kaki-panel-max-height),calc(100vh - 100px));
  display:flex;flex-direction:column;background:var(--kaki-surface);color:var(--kaki-text);font-family:var(--kaki-font);
  border:1px solid var(--kaki-border);border-radius:calc(var(--kaki-radius) + 4px);box-shadow:0 12px 32px color-mix(in srgb,var(--kaki-text) 16%,transparent);
  overflow:hidden;box-sizing:border-box;font-size:16px;line-height:1.5}
.panel *{box-sizing:border-box;font-family:inherit;letter-spacing:normal}
@media (max-width:479px){.panel{position:fixed;inset:0;width:100vw;height:100dvh;border-radius:0}}
.header{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--kaki-border)}
.title{margin:0;font-size:16px;font-weight:600;flex:1}
.ai{font-size:12px;color:var(--kaki-muted)}
.icon-btn{width:44px;height:44px;border:0;background:transparent;color:var(--kaki-text);border-radius:var(--kaki-radius);cursor:pointer;
  display:flex;align-items:center;justify-content:center;padding:0}
.icon-btn:focus-visible,.send:focus-visible,textarea:focus-visible{outline:2px solid var(--kaki-accent);outline-offset:2px}
.log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;margin:0;list-style:none}
.empty{color:var(--kaki-muted);font-size:14px;margin:auto 0}
.msg{max-width:85%;padding:8px 12px;border-radius:min(calc(var(--kaki-radius) + 4px),20px);white-space:pre-wrap;word-wrap:break-word}
.msg.visitor{align-self:flex-end;background:var(--kaki-accent);color:var(--kaki-on-accent)}
.msg.agent,.msg.system{align-self:flex-start;background:var(--kaki-subtle);color:var(--kaki-text)}
.msg.staff{align-self:flex-start;background:var(--kaki-info-bg);color:var(--kaki-text)}
.disc{align-self:center;display:flex;align-items:center;gap:4px;font-size:12px;line-height:16px;color:var(--kaki-muted);text-align:center;padding:0 12px 4px}
.disc svg{flex:none}
.typing{align-self:flex-start;display:inline-flex;gap:4px;padding:14px 12px;background:var(--kaki-subtle);border-radius:12px}
.typing i{width:6px;height:6px;border-radius:9999px;background:var(--kaki-muted);animation:k-pulse 1s infinite}
.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
@keyframes k-pulse{50%{opacity:.35}}
.notice{align-self:center;font-size:12px;line-height:16px;color:var(--kaki-muted);background:var(--kaki-subtle);padding:4px 10px;border-radius:9999px;text-align:center}
@media (prefers-reduced-motion:reduce){.typing i{animation:none}}
.error{color:var(--kaki-text);background:var(--kaki-subtle);border-left:3px solid var(--kaki-border-strong);padding:8px 12px;font-size:14px;margin:0 16px}
.composer{display:flex;gap:8px;padding:12px;border-top:1px solid var(--kaki-border)}
.composer textarea{flex:1;resize:none;min-height:44px;max-height:120px;padding:10px 12px;border:1px solid var(--kaki-border-strong);
  border-radius:var(--kaki-radius);font-size:16px;color:var(--kaki-text);background:var(--kaki-surface)}
.send{min-width:64px;height:44px;border:0;border-radius:var(--kaki-radius);background:var(--kaki-accent);color:var(--kaki-on-accent);
  font-size:14px;font-weight:600;cursor:pointer;padding:0 16px}
.send:disabled{opacity:.6;cursor:default}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
