import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type AvatarProps = HTMLAttributes<HTMLSpanElement> & {
  initials: string
}

export function Avatar({ className, initials, ...props }: AvatarProps) {
  return (
    <span className={cn('oc-avatar', className)} aria-label={`Avatar ${initials}`} {...props}>
      {initials}
    </span>
  )
}
