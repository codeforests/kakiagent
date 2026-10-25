# UI Design: FEAT-032 — Widget install, theme matching, allowed origins, install check

> Feature from: [implementation-plan.md](../../03-planning/implementation-plan.md) §4 (E3) · Pairs with: [technical-design.md](technical-design.md)
> Screens: SCR-APP-037 (new, partial), SCR-APP-011 (new, partial), SCR-WGT-001 (extended) · Mode: per-feature · Status: Draft · Date: 2026-10-25

No design tool is connected (the design MCP servers failed to connect in this session) and the manifest policy is `code-native`, so the screens are code-native specs. Every value comes from design.md and `tokens.json`; the dashboard uses `var(--…)` only and the widget `--kaki-*` only. Components: `widget-preview`, `snippet-box`, `tabs`, `field`, `text-input`, `select`, `radio`, `button`, `icon-button`, `chip`, `alert`, `card`, `data-list`, `confirm-dialog`, `empty-state`, `error-state`, `skeleton`, `toast`. No new component or token.

Install-check chip: `waiting` "Waiting for your website" (neutral, spinner after 300 ms), `detected` "Installed on {host}" (success-soft, check icon), `wrong_domain` "Loaded on {host}, which isn't allowed" (warning-soft). Detection copy: `queued`/`running` "Matching your website…", `done` "Matched to {host} on {date}", `failed` per code: `unreachable` "We couldn't open {host}.", `blocked` "{host} isn't a public website we can open.", `timeout` "{host} took too long to load.", `no_page` "{host} didn't return a page." Colour is never the only signal: every chip has text.

## Shared parts (`pages/widget-parts.tsx`)

- **`WidgetPreview`** (design.md `widget-preview`): a `card` holding the preview iframe (`title` "Widget preview", height 520 desktop, 440 mobile, `sandbox="allow-scripts"`), above it a segmented `radio` group "Light · Dark" that sets the preview scheme (defaults to the detected scheme; doesn't change settings). Below it a caption with the detection copy and a `ghost` small "Match again" (disabled while queued/running).
- **`AppearanceForm`**: four `field`s, each showing the detected value and an override:
  - **Colour:** `radio` "Match my website ({swatch} {hex})" / "Choose a colour" revealing a native colour input plus a hex `text-input`. When the clamp changes the colour, help text "Adjusted to {hex} so text stays readable." (from `clampAccent`; D5).
  - **Font:** `select` "Match my website ({family})" / "System font" / "Custom…" (revealing a `text-input` "Font name, as on your website"; help "We use fonts your site already loads. We never download fonts.").
  - **Corners:** `select` "Match my website ({n} px)" / "Square (0 px)" / "Slightly rounded (6 px)" / "Rounded (12 px)" / "Very rounded (20 px)".
  - **Light or dark:** `radio` "Follow my website" / "Always light" / "Always dark".
  - **Position:** `radio` "Bottom right" / "Bottom left".
  - **Logo** (`LogoField`): 48 px preview tile (subtle fill, radius md), `secondary` "Upload logo" (file input, accept png/jpeg/webp), `ghost` "Remove" when set; help "PNG, JPG or WebP, up to 100 KB. Shown on the chat button."; errors inline: 413 "That file is over 100 KB.", 415 "Use a PNG, JPG or WebP image."
  - When nothing was detected yet, the "Match my website" options read "Match my website (not checked yet)" and the defaults apply.
  - Footer: `primary` "Save" (disabled until changed), `ghost` "Reset to my website" (clears overrides, not position or logo). Every change updates the preview at once (postMessage); Save persists. Saved: toast "Saved. Your widget looks like this on your website now." Leaving with unsaved changes: the shared unsaved-changes prompt.
- **`SnippetBox`** (design.md `snippet-box`): heading "Add this line to your website", the snippet in mono on subtle fill, `secondary` "Copy" (announces "Copied" via the live region), then `tabs` WordPress · Wix · Shopify · HTML, each with 3–4 numbered steps:
  - WordPress: "In WordPress, open Appearance → Theme File Editor, or use a header-scripts plugin such as WPCode." / "Paste the line just before `</body>`." / "Save, then open your website."
  - Wix: "In Wix, open Settings → Custom code." / "Click Add custom code, paste the line, and choose All pages, Body - end." / "Publish your site."
  - Shopify: "In Shopify, open Online Store → Themes → … → Edit code." / "Open `theme.liquid` and paste the line just before `</body>`." / "Save."
  - HTML: "Paste the line just before `</body>` on every page." / "Upload the pages to your website."
- **`InstallCheck`**: the chip plus one line: `waiting` "Once the line is on your website, open any page and this turns green." · `detected` "Last seen {relative time}." · `wrong_domain` `alert` (warning) "The widget loaded on {host}, which isn't on your list of websites, so it showed nothing there." with `secondary` small "Add {host}" (calls add origin). Polls while `waiting`/`wrong_domain` and the tab is visible; the change to `detected` is announced in a polite live region and a toast "Your widget is on {host}."
- **`OriginsList`**: `data-list` of origins, each with the host, a chip "From your website" when `fromWebsite`, and an `icon-button` "Remove {host}" → `confirm-dialog` "Stop the widget on {host}?" body "The chat button disappears from {host} the next time a page loads." [Remove] (danger) [Cancel]. Below: `text-input` "Add a website" (placeholder "shop.example.sg") + `secondary` "Add"; inline errors: `invalid_origin` "Enter a website address like shop.example.sg. Use https, and list each subdomain.", `origin_exists` "{host} is already on the list.", `too_many_origins` "You can add up to 20 websites." Empty: `empty-state` "No websites yet. Add the website where you'll put the widget."

## SCR-APP-037 — Website widget

- **Strategy and source:** code-native (this section).
- **Route:** `/settings/widget`, linked from the Settings row "Website widget" (`pages/settings.tsx`). Breadcrumb "Settings / Website widget". Roles: Owner, Admin (`settings.manage`); Agents get the permission state "Only the Owner and Admins can change the website widget."
- **Contract bindings:** `GET /api/v1/widget`, `PUT /api/v1/widget/appearance`, `POST /api/v1/widget/theme/detect`, `PUT /api/v1/widget/logo`, `DELETE /api/v1/widget/logo`, `POST /api/v1/widget/origins`, `DELETE /api/v1/widget/origins/:origin`.
- **Layout:** title "Website widget", lede "How the chat button looks on your website, where it's allowed, and how to install it." Desktop ≥ 1024: two columns, left (7/12) sections Look (`AppearanceForm`), Install (`SnippetBox`, `InstallCheck`), Websites (`OriginsList`); right (5/12) the `WidgetPreview`, sticky under the top bar. Below 1024: one column, the preview first and collapsed to 360 px tall, then the sections.
- **States:** loading (skeletons for preview and form); error (`error-state` "We couldn't load your widget settings." [Try again]); no origins (Websites empty state, preview still shows defaults, Install shows `alert` info "Add your website below first, so the widget knows where it may appear."); detecting; detected; detect failed (`alert` warning with the failure copy and [Try again], defaults keep applying); install waiting / detected / wrong domain; permission.
- **Out of scope here (D1):** pre-live mode, tracking and consent mode, proactive greetings; no placeholders for them.

## SCR-APP-011 — Wizard · Add to your website

- **Strategy and source:** code-native (this section).
- **Route:** `/setup/website`, step 5 of the setup (after "Test your assistant", whose Continue now goes here). FEAT-035 adds the wizard frame and the other-channels block; this page uses the same page-lede pattern as `SetupTestPage`.
- **Contract bindings:** as SCR-APP-037.
- **Layout:** "Step 5 of the setup", title "Add to your website", lede "Your assistant's chat button, matched to your website. Change anything you like, then add one line to your site." Sections in order, one column on all widths with the preview beside step 1 on desktop: 1. "Check the look" (`WidgetPreview` + `AppearanceForm`, collapsed to Colour, Light or dark and Position with a `link` "More options" for font, corners and logo); 2. "Add it to your website" (`SnippetBox`); 3. "Check it's working" (`InstallCheck`; the Websites list appears only when the install check is `wrong_domain` or there are no origins).
- **On arrival:** if detection is `none` and there is a `siteUrl`, the page requests detection once.
- **Footer:** `primary` "Continue" to `/` (enabled always: installing can wait), caption "You can change this any time in Settings → Website widget." When `detected`, the caption reads "Your widget is on {host}."
- **States:** as SCR-APP-037 plus "no site yet" (no `siteUrl`: step 1 shows the defaults with `alert` info "Add your website in Sources to match its look." linking to `/setup/sources`). The pre-live form-locked state belongs to FEAT-034 (ONB-10).

## SCR-WGT-001 — Launcher (extended)

- **Strategy and source:** code-native (this section); anchor spec unchanged otherwise.
- 56 px circle in `--kaki-accent` (clamped), icon in `--kaki-on-accent`; with a logo, the logo fills a 36 px circle centred on the accent (object-fit contain), `alt=""` because the button's `aria-label` "Chat with {bot name}" names it. Bottom-right or bottom-left, 20 px from the edge (`--kaki-edge-offset`); the panel opens from the same corner.
- States added: `host-light`, `host-dark` (tokens follow the page live), `left` position, `logo`, `hidden (unlisted origin)`: nothing rendered, no element added.
- Preview mode (`preview.html`): the launcher and an open panel with a sample greeting, a visitor question "Do you deliver to Tampines?" and a reply, composer disabled with the note "Preview: messages aren't sent."

## Gaps and escalations

- Pre-live mode and the locked form state (FEAT-034), tracking and consent (FEAT-029), proactive greetings (FEAT-030), other channels on the wizard step (FEAT-034+), the wizard frame (FEAT-035).
- No screenshot of the tenant's site behind the preview (technical-design D6).
