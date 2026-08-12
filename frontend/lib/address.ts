// Client-side mirror of backend/app/services/validation.py. The backend is authoritative --
// this only gives instant feedback in the create/edit forms so a mistyped address ("192.168.1.o")
// is caught before a round-trip. Keep the two heuristics in step if either changes.

function isAsciiDigits(token: string): boolean {
  return token.length > 0 && /^[0-9]+$/.test(token);
}

// True when the value reads as an IPv4 attempt rather than a hostname: either every
// dot-group is numeric, or there are four groups and at least three are numeric (the classic
// digit-for-letter typo). A hostname like "10.internal.corp.com" has one numeric group and
// is left alone.
export function looksLikeIpv4Attempt(value: string): boolean {
  const parts = value.split(".");
  if (parts.every(isAsciiDigits)) return true;
  const numeric = parts.filter(isAsciiDigits).length;
  return parts.length === 4 && numeric >= 3;
}

export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255);
}

// Returns an error string when the value looks like an IP but is not a valid one; "" when it
// is a valid IP, a hostname, or empty (emptiness is a required-field concern handled elsewhere).
export function addressError(value: string): string {
  const candidate = (value || "").trim();
  if (!candidate) return "";
  if (looksLikeIpv4Attempt(candidate) && !isValidIpv4(candidate)) {
    return `"${value}" looks like an IP address but is not a valid one. Each of the four parts must be a number 0-255 (e.g. 192.168.1.10). For a hostname, use letters (e.g. server.example.com).`;
  }
  return "";
}
