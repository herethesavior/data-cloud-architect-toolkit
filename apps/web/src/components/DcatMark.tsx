interface DcatMarkProps {
  size?: number;
  className?: string;
}

export function DcatMark({ size = 40, className = '' }: DcatMarkProps) {
  return (
    <img
      src="/dcat-icon-192.png"
      alt=""
      width={size}
      height={size}
      decoding="async"
      draggable={false}
      className={`shrink-0 rounded-xl object-cover ${className}`}
    />
  );
}
