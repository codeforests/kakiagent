import { vitestConfig } from '../../vitest.shared.ts';

// Core package: 70% line coverage enforced (architecture §8.7, NFR-12).
export default vitestConfig({ thresholds: { lines: 70 } });
