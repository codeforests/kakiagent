/**
 * The devices list's label (FEAT-008 §5.1, D6): "{Browser} on {OS}" from the User-Agent
 * alone. The tables are ordered: Edge and Samsung Internet also say Chrome, Chrome also
 * says Safari, an iPhone also says Mac OS X and Android also says Linux.
 */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(Chrome|CriOS)\//, 'Chrome'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

const first = (ua: string, table: [RegExp, string][]) => table.find(([re]) => re.test(ua))?.[1];

export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = first(ua, BROWSERS);
  const os = first(ua, SYSTEMS);
  return browser && os ? `${browser} on ${os}` : 'Unknown device';
}
