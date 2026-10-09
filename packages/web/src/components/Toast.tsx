import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cx } from '../lib/dom';
import { Icon } from './Icon';
import { STATUS_ICON, STATUS_WORD, type StatusTone } from './tone';

export interface ToastInput {
  /** Default `info`. */
  tone?: StatusTone;
  /** One line stating what happened ("Rollback to v1.4 passed acceptance tests"). */
  title: string;
  body?: ReactNode;
  /** Optional follow-up ("Open", "Review"). */
  action?: { label: string; onClick: () => void };
  /**
   * Auto-dismiss after ms (paused while hovered or focused). Default 6000 for info/ok; warn/danger stay until
   * dismissed. `null` = persistent.
   */
  duration?: number | null;
}

interface ToastRecord extends ToastInput {
  id: string;
}

export interface ToastApi {
  /** Shows a notification and returns its id. Call it from event handlers and stream events only. */
  notify: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const MAX_VISIBLE = 4;

/** Mount once near the root. Owns the polite live region that announces notifications. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: string) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const notify = useCallback((toast: ToastInput) => {
    seq.current += 1;
    const id = `toast-${seq.current}`;
    setToasts((all) => [...all, { ...toast, id }].slice(-MAX_VISIBLE));
    return id;
  }, []);
  const api = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className="aoc-toasts" aria-label="Notifications">
        <div aria-live="polite" aria-relevant="additions text" className="aoc-toasts__list">
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} dismiss={dismiss} />
          ))}
        </div>
      </section>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, dismiss }: { toast: ToastRecord; dismiss: (id: string) => void }) {
  const tone = toast.tone ?? 'info';
  const duration =
    toast.duration === undefined ? (tone === 'info' || tone === 'ok' ? 6000 : null) : toast.duration;
  const [paused, setPaused] = useState(false);
  const { id } = toast;
  const onDismiss = useCallback(() => dismiss(id), [dismiss, id]);

  useEffect(() => {
    if (duration === null || paused) return undefined;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [duration, paused, onDismiss]);

  return (
    <div
      className={cx('aoc-toast', `aoc-toast--${tone}`)}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon name={STATUS_ICON[tone]} size={16} className="aoc-toast__icon" />
      <div className="aoc-toast__content">
        <p className="aoc-toast__title">
          <span className="aoc-sr-only">{STATUS_WORD[tone]}: </span>
          {toast.title}
        </p>
        {toast.body && <div className="aoc-toast__body">{toast.body}</div>}
        {toast.action && (
          <button
            type="button"
            className="aoc-toast__action"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        className="aoc-toast__dismiss"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** Access the notifications API. Outside a provider it is a no-op, so components stay testable. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

const NOOP: ToastApi = { notify: () => '', dismiss: () => undefined };
