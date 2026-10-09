import { useId, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx, useFocusTrap, useInertBackground } from '../lib/dom';
import { IconButton } from './Button';

interface ModalSurfaceProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  dismissOnBackdrop: boolean;
  role: 'dialog' | 'alertdialog';
  kind: 'dialog' | 'drawer';
  className?: string;
  style?: CSSProperties;
}

function ModalSurface({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  initialFocus,
  dismissOnBackdrop,
  role,
  kind,
  className,
  style,
}: ModalSurfaceProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open, { initialFocus, onEscape: onClose });
  useInertBackground(open);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={cx('aoc-overlay', `aoc-overlay--${kind}`)}
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(`aoc-${kind}`, className)}
        style={style}
      >
        <header className={`aoc-${kind}__header`}>
          <h2 id={titleId} className={`aoc-${kind}__title`}>
            {title}
          </h2>
          <IconButton icon="close" label="Close" onClick={onClose} noTooltip />
        </header>
        {description && (
          <div id={descId} className={`aoc-${kind}__description`}>
            {description}
          </div>
        )}
        <div className={`aoc-${kind}__body`}>{children}</div>
        {footer && <footer className={`aoc-${kind}__footer`}>{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface DialogProps {
  open: boolean;
  /** Called on Escape, the close button and (by default) a backdrop click. */
  onClose: () => void;
  /** Dialog heading; also its accessible name. */
  title: string;
  /** Explanation under the title; becomes the accessible description. */
  description?: ReactNode;
  children?: ReactNode;
  /** Action buttons, right-aligned (primary last). */
  footer?: ReactNode;
  /** `sm` 400px, `md` 560px (default), `lg` 760px. */
  size?: 'sm' | 'md' | 'lg';
  /** Element to focus on open (default: first focusable). Point it at the safe choice for destructive confirms. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Close on backdrop click. Default true; set false for forms holding unsaved input. */
  dismissOnBackdrop?: boolean;
  /** `alertdialog` for confirmations that interrupt (rollback, revoke). Default `dialog`. */
  role?: 'dialog' | 'alertdialog';
}

/**
 * Modal dialog: focus moves inside and is trapped (Tab/Shift+Tab wrap), Escape closes, the page behind is
 * inert, and focus returns to the opener on close.
 */
export function Dialog({ size = 'md', dismissOnBackdrop = true, role = 'dialog', ...rest }: DialogProps) {
  return (
    <ModalSurface
      {...rest}
      dismissOnBackdrop={dismissOnBackdrop}
      role={role}
      kind="dialog"
      className={`aoc-dialog--${size}`}
    />
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Drawer heading; also its accessible name. */
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Edge it slides from. Default `right` (detail panels); the mobile nav uses `left`. */
  side?: 'left' | 'right';
  /** Width in px on wide screens (always full-width on phones). Default 440. */
  width?: number;
  initialFocus?: RefObject<HTMLElement | null>;
  dismissOnBackdrop?: boolean;
}

/** Modal side panel for record details and the mobile navigation. Same focus rules as Dialog. */
export function Drawer({ side = 'right', width = 440, dismissOnBackdrop = true, ...rest }: DrawerProps) {
  return (
    <ModalSurface
      {...rest}
      dismissOnBackdrop={dismissOnBackdrop}
      role="dialog"
      kind="drawer"
      className={`aoc-drawer--${side}`}
      style={{ '--drawer-w': `${width}px` } as CSSProperties}
    />
  );
}
