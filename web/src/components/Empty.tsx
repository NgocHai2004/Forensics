import type { ComponentType, ReactNode } from 'react'

export default function Empty(props: {
  icon: ComponentType<{ className?: string }>
  title: string
  desc?: string
  action?: ReactNode
}) {
  const Icon = props.icon
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Icon className="h-6 w-6" />
      </div>
      <p className="font-display font-semibold text-navy">{props.title}</p>
      {props.desc && <p className="max-w-sm text-sm text-muted">{props.desc}</p>}
      {props.action && <div className="mt-2">{props.action}</div>}
    </div>
  )
}
