import { EmptyState } from '@kaki/ui';

/** A section that exists in the navigation but is built by a later feature (plan §4). */
export function Placeholder({ title, feature }: { title: string; feature: string }) {
  return (
    <>
      <h1 className="page-title">{title}</h1>
      <EmptyState title="Not built yet">This section arrives with {feature}.</EmptyState>
    </>
  );
}
