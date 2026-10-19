/** design.md §5 rule 3: a skip link reading "Skip to content". */
export function SkipLink({ target = '#main' }: { target?: string }) {
  return (
    <a className="kaki-skip-link" href={target}>
      Skip to content
    </a>
  );
}
