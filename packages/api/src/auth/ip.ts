/**
 * IPv4/IPv6 private-range detection.
 *
 * Lifted out of `domain.ts` so leaf modules like `allowedAddresses.ts` can
 * depend on `isPrivateIP` without forming a cycle (`domain` re-exports the
 * `isPrivateIP` symbol below for backward compatibility with existing
 * callers, but this is the canonical location).
 *
 * Coverage:
 *  - IPv4: 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16,
 *    172.16/12, 192.0.0/24 (RFC 5736), 192.168/16, 198.18/15 (benchmarking),
 *    224/3 (multicast/reserved).
 *  - IPv6: ::1, ::, fc00::/7 (unique-local), fe80::/10 (link-local).
 *  - 4-in-6 mappings: IPv4-mapped (::ffff:0:0/96), compatible (::/96), and
 *    translated (::ffff:0:0:0/96), in dotted or hex form.
 *  - Embedded private IPv4 in 6to4 (2002::/16), NAT64 (64:ff9b::/96), and
 *    Teredo (2001::/32) addresses.
 */

/** Checks if IPv4 octets fall within private, reserved, or non-routable ranges */
export function isPrivateIPv4(a: number, b: number, c: number): boolean {
  if (a === 0) {
    return true;
  }
  if (a === 10) {
    return true;
  }
  if (a === 127) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 192 && b === 0 && c === 0) {
    return true;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

/** Checks if a pre-normalized (lowercase, bracket-stripped) IPv6 address falls within fe80::/10 */
function isIPv6LinkLocal(ipv6: string): boolean {
  if (!ipv6.includes(':')) {
    return false;
  }
  const firstHextet = ipv6.split(':', 1)[0];
  if (!firstHextet || !/^[0-9a-f]{1,4}$/.test(firstHextet)) {
    return false;
  }
  const hextet = parseInt(firstHextet, 16);
  // /10 mask (0xffc0) preserves top 10 bits: fe80 = 1111_1110_10xx_xxxx
  return (hextet & 0xffc0) === 0xfe80;
}

/** Checks if an IPv6 address embeds a private IPv4 via 6to4, NAT64, or Teredo */
function hasPrivateEmbeddedIPv4(ipv6: string): boolean {
  if (!ipv6.startsWith('2002:') && !ipv6.startsWith('64:ff9b::') && !ipv6.startsWith('2001::')) {
    return false;
  }
  const segments = ipv6.split(':').filter((s) => s !== '');

  if (ipv6.startsWith('2002:') && segments.length >= 3) {
    const hi = parseInt(segments[1], 16);
    const lo = parseInt(segments[2], 16);
    if (!isNaN(hi) && !isNaN(lo)) {
      return isPrivateIPv4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff);
    }
  }

  if (ipv6.startsWith('64:ff9b::')) {
    const lastTwo = segments.slice(-2);
    if (lastTwo.length === 2) {
      const hi = parseInt(lastTwo[0], 16);
      const lo = parseInt(lastTwo[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        return isPrivateIPv4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff);
      }
    }
  }

  // RFC 4380: Teredo stores external IPv4 as bitwise complement in last 32 bits
  if (ipv6.startsWith('2001::')) {
    const lastTwo = segments.slice(-2);
    if (lastTwo.length === 2) {
      const hi = parseInt(lastTwo[0], 16);
      const lo = parseInt(lastTwo[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        return isPrivateIPv4((~hi >> 8) & 0xff, ~hi & 0xff, (~lo >> 8) & 0xff);
      }
    }
  }

  return false;
}

/**
 * Checks if an IP address belongs to a private, reserved, or link-local range.
 * Handles IPv4, IPv6, and IPv4-embedded IPv6 addresses.
 */
export function isPrivateIP(ip: string): boolean {
  let normalized = ip
    .toLowerCase()
    .trim()
    .replace(/^\[|\]$/g, '');

  const mappedMatch = normalized.match(
    /^::ffff:(?:0:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (mappedMatch) {
    const [, a, b, c] = mappedMatch.map(Number);
    return isPrivateIPv4(a, b, c);
  }

  // DNS can return expanded or dotted-tail IPv6 instead of URL-normalized hosts.
  if (normalized.includes(':')) {
    try {
      // A zone ID selects an interface; classify the address independently of it.
      const zoneIndex = normalized.indexOf('%');
      const address = zoneIndex === -1 ? normalized : normalized.slice(0, zoneIndex);
      normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    } catch {
      return false;
    }
  }

  // IPv4-compatible, mapped, and RFC 2765 translated forms share the low 32 bits.
  const hexMappedMatch = normalized.match(/^(?:::ffff:(?:0:)?|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMappedMatch) {
    const hi = parseInt(hexMappedMatch[1], 16);
    const lo = parseInt(hexMappedMatch[2], 16);
    return isPrivateIPv4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff);
  }

  const ipv4Match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c] = ipv4Match.map(Number);
    return isPrivateIPv4(a, b, c);
  }

  if (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') || // fc00::/7 — exactly prefixes 'fc' and 'fd'
    normalized.startsWith('fd') ||
    isIPv6LinkLocal(normalized) // fe80::/10 — spans 0xfe80–0xfebf; bitwise check required
  ) {
    return true;
  }

  if (hasPrivateEmbeddedIPv4(normalized)) {
    return true;
  }

  return false;
}
