import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

// Drive a native <dialog> as a modal: focus trap, Escape-to-close, backdrop, and
// focus restoration on close all come from the platform (a11y is not simplified).
// showModal gives the full treatment in browsers; jsdom (Seam-2 tests) implements
// neither showModal nor close, so fall back to the `open` attribute, which still
// exposes the dialog role and its contents. Shared by the simple Modal below and
// the wider issue modal (#36).
export function useModalDialog(): RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    return () => {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
    };
  }, []);
  return ref;
}

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: ModalProps) {
  const ref = useModalDialog();
  const titleId = useId();

  return (
    // Click-away is a mouse-only enhancement; keyboard users close with Escape (the
    // dialog's native onCancel below), so keyboard parity is intact. The a11y rules
    // can't see that, hence the scoped disable.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // Click-away close: a click on the dialog element itself is the backdrop/padding.
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
