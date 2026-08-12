"""Host-address validation shared by CSV import and the server create/update endpoints.

The `ip_address` field in this product is free text on purpose: it usually holds a dotted-quad
IPv4 literal, but a DNS name ("db01.internal", "web.example.com") is equally valid and some
sites put one there instead of a numeric address. So the rule cannot be "must be an IPv4" --
it has to first decide *whether the operator was typing an address at all*, and only then hold
that value to the octet format.

The bug this closes: "192.168.1.o" (a mistyped 0) sailed through, because nothing checked that
an IP-shaped value was actually a valid IP. The classifier below treats a value as an IPv4
attempt when it is numeric-dominant, then requires it to be a real IPv4; anything that reads as
a hostname is accepted untouched.
"""

import re

# ASCII-only octet: [0-9] (not \d, which also matches Unicode digits like superscripts), 1-3
# digits. Range (0-255) is checked separately so the message can say which part is out of range.
_OCTET = re.compile(r"[0-9]{1,3}")


def _parts(value: str) -> list[str]:
    return value.split(".")


def _is_ascii_digits(token: str) -> bool:
    return bool(token) and token.isascii() and token.isdigit()


def looks_like_ipv4_attempt(value: str) -> bool:
    """True when `value` reads as someone typing an IPv4 address rather than a hostname.

    Two signals, either sufficient:
      * every dot-separated group is purely numeric ("192.168.1", "10", "192.168.0.5") -- an
        unambiguous address attempt, complete or not; and
      * exactly four groups of which at least three are purely numeric ("192.168.1.o") -- the
        classic digit-for-letter typo.

    A hostname like "10.internal.corp.com" has only one numeric group and so is NOT flagged,
    which keeps legitimate numeric-leading domains out of the octet check.
    """
    parts = _parts(value)
    if all(_is_ascii_digits(part) for part in parts):
        return True
    numeric = sum(1 for part in parts if _is_ascii_digits(part))
    return len(parts) == 4 and numeric >= 3


def is_valid_ipv4(value: str) -> bool:
    parts = _parts(value)
    if len(parts) != 4:
        return False
    for part in parts:
        if not _OCTET.fullmatch(part) or int(part) > 255:
            return False
    return True


def validate_host_address(value: str) -> None:
    """Raise ValueError if `value` looks like an IPv4 address but is not a valid one.

    Empty input and hostnames/domain names pass silently -- emptiness is enforced by the
    required-field checks upstream, and a domain name may be "anything" here.
    """
    candidate = (value or "").strip()
    if not candidate:
        return
    if looks_like_ipv4_attempt(candidate) and not is_valid_ipv4(candidate):
        raise ValueError(
            f"'{value}' looks like an IP address but is not a valid one. "
            "Each of the four parts must be a whole number 0-255 (e.g. 192.168.1.10). "
            "For a hostname, use letters (e.g. server.example.com)."
        )
