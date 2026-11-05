/**
 * 歯車の絵。稼働中はゆっくり回る（OS の「視差効果を減らす」設定がオンのときは回さない）。装飾なので読み上げない。
 *
 * 【誰が使うか】ProductionStatusWidget。
 */
export function GearIcon({ spinning, className, size = 44 }: { spinning: boolean; className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <g className={spinning ? "origin-center motion-safe:animate-spin" : undefined} style={spinning ? { animationDuration: "4s" } : undefined}>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
      </g>
    </svg>
  );
}
