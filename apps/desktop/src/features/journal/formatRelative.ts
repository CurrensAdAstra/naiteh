/** Convert a unix timestamp (seconds) into a short human label. */
export function formatRelative(unixSeconds: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return "—";
  const diffSec = Math.floor(nowMs / 1000) - unixSeconds;
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604_800) return `${Math.floor(diffSec / 86_400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
