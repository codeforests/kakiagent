import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link } from 'react-router';
import { useSignOut } from '../lib/sign-out.ts';

/** The top bar's avatar menu (design.md §3, §4.5 `menu`). */
export function AccountMenu({ email }: { email: string | undefined }) {
  const signOut = useSignOut();
  const signOutEverywhere = useSignOut(true);
  return (
    // Non-modal: a modal menu aria-hides the page while its links stay focusable.
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger className="avatar avatar--button" aria-label="Account">
        {email ? email[0]!.toUpperCase() : ' '}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={8}>
          {email && <DropdownMenu.Label className="menu__label">{email}</DropdownMenu.Label>}
          <DropdownMenu.Item className="menu__item" asChild>
            <Link to="/account">My account</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu__divider" />
          <DropdownMenu.Item className="menu__item" onSelect={() => signOut.mutate()}>
            Sign out
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu__divider" />
          <DropdownMenu.Item
            className="menu__item menu__item--danger"
            onSelect={() => signOutEverywhere.mutate()}
          >
            Sign out of all devices
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
