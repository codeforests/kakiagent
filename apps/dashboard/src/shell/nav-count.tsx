/** The count pill on a nav entry (design.md `nav-item` count badge). */
export function NavCount({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <span className="count-pill count-pill--danger nav-item__count">
      {count}
      <span className="sr-only"> failed</span>
    </span>
  );
}
