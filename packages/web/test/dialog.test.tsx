import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Dialog, Drawer } from '../src/components';

function Harness({
  onClose = () => undefined,
  dismissOnBackdrop = true,
}: {
  onClose?: () => void;
  dismissOnBackdrop?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Roll back…
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        role="alertdialog"
        title="Roll back to v1.4.2?"
        description="Nothing touches main until you approve the result."
        dismissOnBackdrop={dismissOnBackdrop}
        initialFocus={cancel}
        footer={
          <>
            <Button ref={cancel} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger">Start rollback</Button>
          </>
        }
      >
        <label>
          Reason <input />
        </label>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('is a labelled, described modal and focuses the initial element', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Roll back…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Roll back to v1.4.2?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Nothing touches main until you approve the result.');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Roll back…' }));
    const close = screen.getByRole('button', { name: 'Close' });
    const input = screen.getByRole('textbox', { name: 'Reason' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const start = screen.getByRole('button', { name: 'Start rollback' });

    await user.tab();
    expect(start).toHaveFocus();
    await user.tab(); // last → wraps to first
    expect(close).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.tab({ shift: true }); // first → wraps to last
    expect(start).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Roll back…' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('closes from the backdrop unless told not to', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Roll back…' }));
    await user.click(document.querySelector('.aoc-overlay') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    const keep = vi.fn();
    render(<Harness onClose={keep} dismissOnBackdrop={false} />);
    await user.click(screen.getByRole('button', { name: 'Roll back…' }));
    await user.click(document.querySelector('.aoc-overlay') as HTMLElement);
    expect(keep).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('Drawer', () => {
  it('traps focus and closes on Escape like Dialog', async () => {
    const user = userEvent.setup();
    function DrawerHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Details
          </button>
          <Drawer open={open} onClose={() => setOpen(false)} title="Change request CR-0142" side="right">
            <a href="#x">Open record</a>
          </Drawer>
        </>
      );
    }
    render(<DrawerHarness />);
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const drawer = screen.getByRole('dialog', { name: 'Change request CR-0142' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Open record' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Details' })).toHaveFocus();
  });
});
