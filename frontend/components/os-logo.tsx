"use client";

import { DISTRO_LOGOS, type DistroLogo } from "@/lib/distro-logos";

// Windows and Oracle Linux are not in simple-icons (removed there over trademark policy), so the
// two get neutral, non-branded glyphs drawn here: a four-pane window and a plain disc.
const WINDOWS_PANES: DistroLogo = {
  title: "Windows",
  hex: "#0078D4",
  path: "M3 3h8.4v8.4H3V3zm9.6 0H21v8.4h-8.4V3zM3 12.6h8.4V21H3v-8.4zm9.6 0H21V21h-8.4v-8.4z",
};
const ORACLE_DISC: DistroLogo = {
  title: "Oracle Linux",
  hex: "#C74634",
  path: "M12 4.5c4.7 0 8.5 1.4 8.5 3.15v8.7C20.5 18.1 16.7 19.5 12 19.5s-8.5-1.4-8.5-3.15v-8.7C3.5 5.9 7.3 4.5 12 4.5zm0 1.8c-3.7 0-6.7 1-6.7 1.35S8.3 9 12 9s6.7-1 6.7-1.35S15.7 6.3 12 6.3z",
};

// Longest-token-first matching: "red hat enterprise linux" must not be caught by the generic
// "linux" entry, and "opensuse" must win over "suse".
const MATCHERS: Array<[RegExp, DistroLogo]> = [
  [/opensuse|open\s*suse/, DISTRO_LOGOS.opensuse],
  [/red\s*hat|rhel/, DISTRO_LOGOS.redhat],
  [/rocky/, DISTRO_LOGOS.rocky],
  [/alma/, DISTRO_LOGOS.alma],
  [/centos/, DISTRO_LOGOS.centos],
  [/fedora/, DISTRO_LOGOS.fedora],
  [/oracle\s*linux|\bol\b|\boel\b/, ORACLE_DISC],
  [/linux\s*mint|\bmint\b/, DISTRO_LOGOS.mint],
  [/ubuntu/, DISTRO_LOGOS.ubuntu],
  [/raspbian|raspberry/, DISTRO_LOGOS.raspbian],
  [/kali/, DISTRO_LOGOS.kali],
  [/debian/, DISTRO_LOGOS.debian],
  [/suse|sles/, DISTRO_LOGOS.suse],
  [/alpine/, DISTRO_LOGOS.alpine],
  [/manjaro/, DISTRO_LOGOS.manjaro],
  [/arch/, DISTRO_LOGOS.arch],
  [/gentoo/, DISTRO_LOGOS.gentoo],
  [/nixos/, DISTRO_LOGOS.nixos],
  [/freebsd|bsd/, DISTRO_LOGOS.freebsd],
  [/windows|win\s*server/, WINDOWS_PANES],
  [/mac\s*os|darwin|osx/, DISTRO_LOGOS.macos],
  [/linux|gnu/, DISTRO_LOGOS.linux],
];

export function matchDistroLogo(text: string): DistroLogo | null {
  const key = text.toLowerCase();
  for (const [pattern, logo] of MATCHERS) if (pattern.test(key)) return logo;
  return null;
}

// Several brand colours (Apple black, SUSE's dark green) vanish against a dark background, so the
// dark-theme copy is the same mark mixed towards white. Brand-accurate in light, legible in dark.
function lightenForDark(hex: string): string {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (luminance > 0.4) return hex;
  const mix = (channel: number) => Math.round(channel + (255 - channel) * 0.6);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// A distro mark rendered at `size` px. Unrecognised systems get no logo at all — the caller
// decides what to show instead, rather than this guessing with a wrong mark.
export function OsLogo({ text, size = 18, title }: { text: string; size?: number; title?: string }) {
  const logo = matchDistroLogo(text);
  if (!logo) return null;
  const label = title || logo.title;
  const dark = lightenForDark(logo.hex);
  const svg = (color: string, className: string) => (
    <svg
      role="img"
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={color}
      className={`${className} shrink-0`}
    >
      <path d={logo.path} />
    </svg>
  );
  return (
    <span title={label} aria-label={label} className="inline-flex items-center">
      {svg(logo.hex, dark === logo.hex ? "" : "dark:hidden")}
      {dark === logo.hex ? null : svg(dark, "hidden dark:block")}
    </span>
  );
}
