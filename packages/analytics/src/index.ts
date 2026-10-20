/**
 * Public interface of the `analytics` module (architecture §5.2): the usage ledger and
 * the cost governor (ADR-021, ADR-007; FEAT-004). Dashboards and the EIS report arrive
 * with FEAT-066 and FEAT-067. Other modules may import only this file.
 */
export {
  DEFAULT_GOVERNOR,
  runCostGovernor,
  usage,
  usageSink,
  type GovernorChange,
  type GovernorConfig,
} from './usage.js';
