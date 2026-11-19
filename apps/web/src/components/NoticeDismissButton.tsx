import { Icon } from './Icon.tsx';

/** Consistent close control for dismissible status and safety notices. */
export function NoticeDismissButton({ label, onClick }: { label: string; onClick: () => void }) {
  const dismiss = () => {
    onClick();
    // The notice is removed with this button, so move focus to the persistent
    // main landmark instead of dropping it back to the document body.
    document.getElementById('main-content')?.focus();
  };

  return (
    <button
      type="button"
      onClick={dismiss}
      aria-label={label}
      title={label}
      className="grid size-7 shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink"
    >
      <Icon name="close" size={14} />
    </button>
  );
}
