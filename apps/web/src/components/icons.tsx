/** 内联 SVG 图标。刻意不引图标库：M1 只用得上这几个，省一份依赖。 */

interface IconProps {
  size?: number;
}

/** 票面图标：一张带几条线的纸 */
export function InvoiceIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="2.2" y="2.2" width="13.6" height="13.6" rx="2.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.4 6.4h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5.4 9.4h7.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5.4 12.4h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function UploadIcon({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 15v3.2A1.8 1.8 0 0 0 5.8 20h12.4A1.8 1.8 0 0 0 20 18.2V15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function PrinterIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      <path d="M5.2 6.4V3.2h7.6v3.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path
        d="M5.2 13.2H3.8a1.6 1.6 0 0 1-1.6-1.6V8.2a1.6 1.6 0 0 1 1.6-1.6h10.4a1.6 1.6 0 0 1 1.6 1.6v3.4a1.6 1.6 0 0 1-1.6 1.6h-1.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <rect x="5.2" y="11" width="7.6" height="4.8" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8.6l3.2 3.2L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WarnIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 2.6l6 11.2H2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6.6v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r="0.9" fill="currentColor" />
    </svg>
  );
}
