import type { Workspace } from '@kaki/contracts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ApiError } from '../lib/api.ts';
import { roleLabel } from '../lib/team.ts';
import { useSwitchWorkspace, useWorkspaces } from '../lib/workspaces.ts';

const ChevronsUpDown = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M7 15l5 5 5-5M7 9l5-5 5 5" />
  </svg>
);

/**
 * The top bar's business name (design.md `tenant-switcher`, FEAT-007 ui-design): a menu of
 * the user's active memberships when there are two or more (AUTH-04), the plain name
 * otherwise. `onLost` reports a workspace the user is no longer a member of.
 */
export function TenantSwitcher({
  name,
  onLost,
}: {
  name: string | undefined;
  onLost: (name: string) => void;
}) {
  const workspaces = useWorkspaces();
  const switcher = useSwitchWorkspace();

  const list = workspaces.data?.workspaces ?? [];
  const current = list.find((w) => w.current)?.name ?? name;

  if (list.length < 2)
    return (
      <span className="topbar__tenant" data-testid="tenant-name">
        {current ?? ' '}
      </span>
    );

  const choose = (w: Workspace) => {
    if (w.current || switcher.isPending) return;
    switcher.mutate(w.id, {
      onError: (err) => {
        if (err instanceof ApiError && err.status === 404) onLost(w.name);
      },
    });
  };

  return (
    <div className="topbar__tenant">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          className="tenant-switcher"
          aria-label={`Switch business, current: ${current ?? ''}`}
          aria-busy={switcher.isPending || undefined}
        >
          <span className="tenant-switcher__name" data-testid="tenant-name">
            {current}
          </span>
          {/* The spinner shows itself after 300 ms (design.md `spinner`). */}
          {switcher.isPending ? (
            <span className="spinner spinner--sm" aria-hidden="true" />
          ) : (
            <ChevronsUpDown />
          )}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="start" sideOffset={8}>
            <DropdownMenu.Label className="menu__label">Your businesses</DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={list.find((w) => w.current)?.id ?? ''}>
              {list.map((w) => (
                <DropdownMenu.RadioItem
                  key={w.id}
                  value={w.id}
                  className="menu__item tenant-switcher__item"
                  onSelect={() => choose(w)}
                >
                  <span className="tenant-switcher__check" aria-hidden="true">
                    <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
                  </span>
                  <span className="tenant-switcher__text">
                    <span>{w.name}</span>
                    <span className="tenant-switcher__role">{roleLabel(w.role)}</span>
                  </span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
