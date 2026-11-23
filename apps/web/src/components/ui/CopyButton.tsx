import { useEffect, useRef, useState } from 'react';
import { Button } from './Button.tsx';
import { Icon } from '../Icon.tsx';
import type { IconName } from '../Icon.tsx';

interface CopyButtonProps {
  value: string;
  label: string;
  icon?: IconName;
  className?: string;
}

/** Copies metadata only; the app never has credentials or session material to copy. */
export function CopyButton({ value, label, icon = 'copy', className = '' }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const showStatus = (next: 'copied' | 'error') => {
    setState(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setState('idle');
      timerRef.current = null;
    }, 1600);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      showStatus('copied');
    } catch {
      showStatus('error');
    }
  };

  const currentLabel = state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : label;
  const currentIcon = state === 'copied' ? 'check' : state === 'error' ? 'warning' : icon;

  return (
    <>
      <Button
        variant="quiet"
        onClick={() => void copy()}
        aria-label={currentLabel}
        className={`px-2 py-1 text-xs ${className}`}
      >
        <Icon name={currentIcon} size={14} />
        <span>{currentLabel}</span>
      </Button>
      <span className="sr-only" role="status">
        {state === 'copied' ? 'Copied to clipboard' : state === 'error' ? 'Copy failed' : ''}
      </span>
    </>
  );
}
