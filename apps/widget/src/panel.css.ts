/** Panel styles: `--kaki-*` variables only (ADR-016, design.md §4.9). */
export const PANEL_CSS = `
.panel{position:absolute;right:0;bottom:0;width:var(--kaki-panel-width);height:min(var(--kaki-panel-max-height),calc(100vh - 100px));
  display:flex;flex-direction:column;background:var(--kaki-surface);color:var(--kaki-text);font-family:var(--kaki-font);
  border:1px solid var(--kaki-border);border-radius:calc(var(--kaki-radius) + 4px);box-shadow:0 12px 32px color-mix(in srgb,var(--kaki-text) 16%,transparent);
  overflow:hidden;box-sizing:border-box;font-size:16px;line-height:1.5}
.panel *{box-sizing:border-box;font-family:inherit;letter-spacing:normal}
@media (max-width:479px){.panel{position:fixed;inset:0;width:100vw;height:100dvh;border-radius:0}}
.header{position:relative;display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--kaki-border)}
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
.composer textarea:disabled{background:var(--kaki-subtle);color:var(--kaki-muted);cursor:default}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.menu{position:absolute;right:16px;top:calc(100% - 8px);z-index:2;min-width:200px;margin:0;padding:4px 0;list-style:none;
  background:var(--kaki-surface);border:1px solid var(--kaki-border);border-radius:var(--kaki-radius);box-shadow:0 12px 32px color-mix(in srgb,var(--kaki-text) 16%,transparent)}
.mi{display:flex;align-items:center;gap:6px;width:100%;min-height:44px;padding:0 16px;border:0;background:transparent;color:var(--kaki-text);
  font-size:14px;line-height:1.3;text-align:left;text-decoration:none;cursor:pointer}
.mi:hover,.mi:focus{background:var(--kaki-subtle);outline:none}
.mi:focus-visible{outline:2px solid var(--kaki-accent);outline-offset:-2px}
.mi svg{flex:none}
.foot{margin:0;padding:0 12px 8px;text-align:center;font-size:12px;color:var(--kaki-muted)}
.foot a,.card a{color:var(--kaki-text);text-decoration:underline}
.card{margin:12px;padding:16px;background:var(--kaki-subtle);border-radius:var(--kaki-radius);display:flex;flex-direction:column;gap:8px}
.card h3{margin:0;font-size:16px;font-weight:600;outline:none}
.card p{margin:0;font-size:14px;color:var(--kaki-muted)}
.card .error{margin:0;color:var(--kaki-text);background:var(--kaki-surface)}
.card .row{display:flex;gap:8px;margin-top:4px}
.card .row .btn{flex:1}
.btn{min-height:44px;border-radius:var(--kaki-radius);font-size:14px;font-weight:600;cursor:pointer;padding:0 16px}
.btn.sec{background:var(--kaki-surface);border:1px solid var(--kaki-border-strong);color:var(--kaki-text)}
.btn.pri{border:0;background:var(--kaki-accent);color:var(--kaki-on-accent)}
.btn:disabled{opacity:.6;cursor:default}
@media (max-width:319px){.card .row{flex-direction:column}}
.btn:focus-visible,.foot a:focus-visible,.card a:focus-visible{outline:2px solid var(--kaki-accent);outline-offset:2px}
.offline{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;justify-content:center}
.offline-card{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--kaki-border);border-radius:var(--kaki-radius);background:var(--kaki-subtle);color:var(--kaki-text)}
.offline-card p{margin:0;white-space:pre-wrap;word-wrap:break-word}
.offline-card p:focus{outline:none}
.contact{display:flex;align-items:center;gap:8px;font-size:14px}
.contact svg{flex:none;color:var(--kaki-muted)}
.contact a{color:var(--kaki-text);text-decoration:underline;min-height:24px;display:inline-flex;align-items:center}
.contact a:focus-visible{outline:2px solid var(--kaki-accent);outline-offset:2px}
`;
