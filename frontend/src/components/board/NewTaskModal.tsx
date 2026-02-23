import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { CreateTicketRequest, TicketPriority } from '@/api/types'

type NewTaskModalProps = {
  open: boolean
  isPending: boolean
  assigneeOptions: string[]
  priorityOptions: TicketPriority[]
  onClose: () => void
  onSubmit: (payload: CreateTicketRequest) => Promise<void>
}

type ValidationErrors = {
  title?: string
  description?: string
}

const DEFAULT_PRIORITIES: TicketPriority[] = ['Critical', 'High', 'Medium', 'Low']

export function NewTaskModal({
  open,
  isPending,
  assigneeOptions,
  priorityOptions,
  onClose,
  onSubmit,
}: NewTaskModalProps) {
  const priorities = priorityOptions.length > 0 ? priorityOptions : DEFAULT_PRIORITIES
  const normalizedAssignees = useMemo(() => {
    if (assigneeOptions.length > 0) {
      return assigneeOptions
    }

    return ['Unassigned']
  }, [assigneeOptions])
  const defaultAssignee = normalizedAssignees[0] ?? 'Unassigned'
  const defaultPriority = priorities.includes('Medium') ? 'Medium' : priorities[0]

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assignee, setAssignee] = useState(defaultAssignee)
  const [priority, setPriority] = useState<TicketPriority>(defaultPriority)
  const [errors, setErrors] = useState<ValidationErrors>({})

  if (!open) {
    return null
  }

  const selectedAssignee = normalizedAssignees.includes(assignee) ? assignee : defaultAssignee
  const selectedPriority = priorities.includes(priority) ? priority : defaultPriority

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const validation = validateForm(title, description)
    if (validation.title || validation.description) {
      setErrors(validation)
      return
    }

    setErrors({})
    await onSubmit({
      title: title.trim(),
      description: description.trim(),
      assignee: selectedAssignee,
      priority: selectedPriority,
    })
  }

  return (
    <div className="drawer-backdrop" role="presentation" onClick={isPending ? undefined : onClose}>
      <section
        className="drawer-panel drawer-panel--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-header">
          <div>
            <p className="drawer-eyebrow">New Ticket</p>
            <h2 id="new-task-title">Create Ticket</h2>
          </div>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Close
          </Button>
        </header>

        <form className="drawer-form" onSubmit={handleSubmit}>
          <label className="form-row">
            <span>Title</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Write a short ticket title"
              maxLength={200}
              required
            />
            {errors.title ? <small className="field-error">{errors.title}</small> : null}
          </label>

          <label className="form-row">
            <span>Description</span>
            <textarea
              className="form-textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Add context, scope, and acceptance criteria"
              maxLength={10000}
            />
            {errors.description ? <small className="field-error">{errors.description}</small> : null}
          </label>

          <div className="form-grid-two">
            <label className="form-row">
              <span>Assignee</span>
              <select
                className="form-select"
                value={selectedAssignee}
                onChange={(event) => setAssignee(event.target.value)}
              >
                {normalizedAssignees.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-row">
              <span>Priority</span>
              <select
                className="form-select"
                value={selectedPriority}
                onChange={(event) => setPriority(event.target.value as TicketPriority)}
              >
                {priorities.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="drawer-actions">
            <Button variant="ghost" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isPending}>
              {isPending ? 'Creating...' : 'Create Task'}
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}

function validateForm(title: string, description: string): ValidationErrors {
  const trimmedTitle = title.trim()
  const trimmedDescription = description.trim()
  const errors: ValidationErrors = {}

  if (!trimmedTitle) {
    errors.title = 'Title is required.'
  } else if (trimmedTitle.length > 200) {
    errors.title = 'Title must be 200 characters or less.'
  }

  if (trimmedDescription.length > 10000) {
    errors.description = 'Description must be 10,000 characters or less.'
  }

  return errors
}
