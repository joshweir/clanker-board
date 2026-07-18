import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'

// Drive a native <dialog> as a modal: focus trap, Escape-to-close, backdrop, and
// focus restoration on close all come from the platform (a11y is not simplified).
// showModal gives the full treatment in browsers; jsdom (Seam-2 tests) implements
// neither showModal nor close, so fall back to the `open` attribute, which still
// exposes the dialog role and its contents. Shared by the simple Modal below and
// the wider issue modal (#36).
export function useModalDialog(): RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) {
      return
    }
    if (typeof dialog.showModal === 'function') {
      dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }
    return () => {
      if (typeof dialog.close === 'function') {
        dialog.close()
      } else {
        dialog.removeAttribute('open')
      }
    }
  }, [])
  return ref
}

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
}

export function Modal({ title, onClose, children }: ModalProps) {
  const ref = useModalDialog()
  const titleId = useId()

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  )
}
