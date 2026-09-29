/**
 * Client keys for IP-based limits, and a small in-memory limiter (owner: CORE). docs/API.md §12.
 *
 * - `clientKey` groups IPv6 clients by /64: one home connection or one cloud server usually
 *   holds a whole /64, so keying on the full address would hand every client an unlimited
 *   supply of fresh keys. IPv4-mapped IPv6 addresses count as the IPv4 address.
 * - `FixedWindowLimiter` is the cheap gate that runs before the session lookup (app.ts), so a
 *   flood of made-up bearer tokens cannot turn into a flood of Postgres queries.
 */
import { isIPv4, isIPv6 } from 'node:net';

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;
const TRAILING_IPV4 = /(\d{1,3}(?:\.\d{1,3}){3})$/;

/** The eight 16-bit groups of a valid IPv6 address, as lower-case hex without leading zeros. */
function ipv6Groups(ip: string): string[] {
  let text = ip;
  const v4 = TRAILING_IPV4.exec(text)?.[1];
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.split('.').map(Number);
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    text = `${text.slice(0, -v4.length)}${hi}:${lo}`;
  }
  const double = text.indexOf('::');
  const head = double >= 0 ? text.slice(0, double) : text;
  const tail = double >= 0 ? text.slice(double + 2) : '';
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const fill = double >= 0 ? 8 - headGroups.length - tailGroups.length : 0;
  return [...headGroups, ...Array<string>(Math.max(0, fill)).fill('0'), ...tailGroups].map((g) =>
    parseInt(g, 16).toString(16),
  );
}

/** The rate-limit key of a client address: IPv4 as is, IPv6 as its /64 prefix. */
export function clientKey(ip: string): string {
  const address = (ip.split('%')[0] ?? ip).toLowerCase();
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return address;
  const mapped = MAPPED_IPV4.exec(address)?.[1];
  if (mapped && isIPv4(mapped)) return mapped;
  return `${ipv6Groups(address).slice(0, 4).join(':')}::/64`;
}

/**
 * Counts hits per key in fixed windows. `hit` returns 0 when allowed, else the milliseconds
 * until the key's window ends. Memory is bounded: past `maxKeys` keys, ended windows are
 * dropped, and if that is not enough every window starts over.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(max: number, windowMs: number, maxKeys = 50_000) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  hit(key: string, nowMs: number): number {
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= nowMs || entry.resetAt - nowMs > this.windowMs) {
      if (!entry && this.windows.size >= this.maxKeys) this.prune(nowMs);
      entry = { count: 0, resetAt: nowMs + this.windowMs };
      this.windows.set(key, entry);
    }
    if (entry.count >= this.max) return entry.resetAt - nowMs;
    entry.count += 1;
    return 0;
  }

  private prune(nowMs: number): void {
    for (const [key, entry] of this.windows) {
      if (entry.resetAt <= nowMs) this.windows.delete(key);
    }
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}
