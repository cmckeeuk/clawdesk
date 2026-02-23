import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
}

export function Button({ className, variant = 'default', type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn('oc-button', variant !== 'default' && `oc-button--${variant}`, className)}
      {...props}
    />
  )
}
