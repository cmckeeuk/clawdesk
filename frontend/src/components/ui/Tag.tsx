import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type TagTone = 'default' | 'warning' | 'danger'

type TagProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: TagTone
}

export function Tag({ className, tone = 'default', ...props }: TagProps) {
  return <span className={cn('oc-tag', tone !== 'default' && `oc-tag--${tone}`, className)} {...props} />
}
