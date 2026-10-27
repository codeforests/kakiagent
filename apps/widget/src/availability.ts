import type { WidgetConfigResponse } from '@kaki/contracts';

/**
 * The loader's go-live check (ONB-10; FEAT-034 ui-design SCR-WGT-005): an offline widget
 * set to "Hide the chat button" adds nothing to the page; "Show a message" mounts as
 * usual and the panel shows the not-live view.
 */
export const mounts = (config: Pick<WidgetConfigResponse, 'availability'>) =>
  config.availability.live || config.availability.mode !== 'hidden';
