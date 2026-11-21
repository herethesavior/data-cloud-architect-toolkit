import { Icon } from '../Icon.tsx';

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
}

export function SearchField({
  value,
  onChange,
  placeholder = 'Search...',
  label = 'Search',
  className = '',
}: SearchFieldProps) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{label}</span>
      <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="input pr-9 pl-9"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded text-ink-faint hover:bg-surface-alt hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </label>
  );
}
