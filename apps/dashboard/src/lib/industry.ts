import type { Industry } from '@kaki/contracts';

/** Industry names for the business profile and Coverage (FEAT-009, FEAT-019). */
export const INDUSTRY_OPTIONS: { value: Industry; label: string }[] = [
  { value: 'fnb', label: 'Food and beverage' },
  { value: 'retail', label: 'Retail' },
  { value: 'beauty_wellness', label: 'Beauty and wellness' },
  { value: 'education', label: 'Education and tuition' },
  { value: 'professional_services', label: 'Professional services' },
  { value: 'home_services', label: 'Home services' },
  { value: 'other', label: 'Other' },
];
export const INDUSTRY_LABEL = Object.fromEntries(INDUSTRY_OPTIONS.map((o) => [o.value, o.label]));
