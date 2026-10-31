/** Settings and retry timing shared by the emails identity sends (magic links, invitations). */

export interface MagicLinkConfig {
  /** `MAGIC_LINK_SECRET`: derives each link's token from its ID (D6). */
  secret: string;
  /** `PUBLIC_APP_URL`: the dashboard origin the link opens. */
  appUrl: string;
}

/** Retry delay after `attempts` failed sends: 10 s, doubling, at most 2 minutes. */
export const backoffSeconds = (attempts: number) => Math.min(10 * 2 ** (attempts - 1), 120);
