import { vitestConfig } from '../../vitest.shared.ts';

// Core package: 70% line coverage enforced once it has code (architecture §8.7, NFR-12).
export default vitestConfig({ thresholds: { lines: 70 } });
