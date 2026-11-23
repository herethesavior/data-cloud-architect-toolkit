interface DcatMarkProps {
  size?: number;
  className?: string;
}

export function DcatMark({ size = 44, className = '' }: DcatMarkProps) {
  return (
    <img
      src="/dcat-icon-192.png"
      alt=""
      width={size}
      height={size}
      decoding="async"
      draggable={false}
      className={`dcat-mark shrink-0 object-contain ${className}`}
    />
  );
}
