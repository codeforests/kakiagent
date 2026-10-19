import { Slot } from '@radix-ui/react-slot';
import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Render the child element (e.g. a router link) with button styling. */
  asChild?: boolean;
}

/** design.md §4.1 `button`: primary, secondary and ghost; 36 px, 44 px on touch. */
export function Button({ variant = 'primary', asChild = false, className, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={['kaki-btn', `kaki-btn--${variant}`, className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}
