import { vitestConfig } from '../../vitest.shared.ts';

// Only platform/pii-mask and platform/outbox are core (architecture §8.7, NFR-12).
export default vitestConfig({
  thresholds: { 'src/pii-mask.ts': { lines: 70 }, 'src/outbox.ts': { lines: 70 } },
});
