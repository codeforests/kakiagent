import type { Message, TrackingMode, WidgetConfigResponse } from '@kaki/contracts';

/** What the loader hands the lazily loaded panel. */
export interface PanelContext {
  shadow: ShadowRoot;
  mount: HTMLElement;
  config: WidgetConfigResponse;
  apiUrl: string;
  close(): void;
  adopt(css: string): void;
  /** Page tracking (FEAT-029 §5.2): the mode, the visitor's stored choice, and setting it. */
  tracking?: {
    mode: TrackingMode;
    choice(): 'accepted' | 'declined' | null;
    setChoice(c: 'accepted' | 'declined'): void;
  };
  /** The dashboard's preview (FEAT-032 §5.3): sample messages, nothing sent or fetched. */
  preview?: { messages: Message[] };
}

export interface PanelModule {
  mountPanel(ctx: PanelContext): { focus(): void };
}
