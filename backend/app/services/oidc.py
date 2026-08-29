"""Optional Keycloak / OIDC single sign-on (Authorization Code + PKCE, backend-for-frontend).

Entirely additive. When OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET are unset,
``configured()`` is False and nothing in here ever runs -- the app keeps its local bcrypt
login and standalone SQLite mode untouched. Set all three (plus APP_PUBLIC_URL, the
browser-facing base of this app) to turn on SSO.

The flow lives in app.api.routes as three public routes:

  GET /api/auth/oidc/status    -> {"enabled": bool}
  GET /api/auth/oidc/login     -> 302 to Keycloak's authorize endpoint (state/PKCE in a cookie)
  GET /api/auth/oidc/callback  -> exchange the code, mint the app JWT, 302 back to the SPA

This module owns only the OIDC mechanics: discovery, JWKS, the authorize URL, PKCE, the token
exchange, access-token validation, and mapping Keycloak claims to an app (email, role). It has
no FastAPI or DB dependency; the route layer wires those in.

Access-token validation, not the id_token: we verify the ACCESS token's signature + issuer +
exp against the realm JWKS, but skip the audience check (``verify_aud`` off) because Keycloak's
access-token ``aud`` is unreliable. Authorisation instead comes from the realm client roles under
``resource_access[client_id].roles`` (see ``extract_identity``).
"""

import base64
import hashlib
import secrets

import httpx
from jose import jwt

from app.core.config import get_settings


class OidcError(Exception):
    """Any failure in the OIDC flow that should surface to the SPA as a clean error."""


# Cached once per issuer; the discovery document and JWKS rarely change and refetching them on
# every login would add two network hops to each sign-in.
_DISCOVERY_CACHE: dict[str, dict] = {}
_JWKS_CACHE: dict[str, dict] = {}

# how long we allow the token endpoint / discovery calls to take before giving up
_HTTP_TIMEOUT = 10.0


def configured() -> bool:
    return get_settings().oidc_configured


def _discovery() -> dict:
    settings = get_settings()
    issuer = settings.oidc_issuer.rstrip("/")
    cached = _DISCOVERY_CACHE.get(issuer)
    if cached is not None:
        return cached
    url = f"{issuer}/.well-known/openid-configuration"
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
            resp = client.get(url)
    except httpx.HTTPError as exc:
        raise OidcError(f"Cannot reach the identity provider: {exc}") from exc
    if resp.status_code != 200:
        raise OidcError(f"OIDC discovery failed ({resp.status_code})")
    doc = resp.json()
    _DISCOVERY_CACHE[issuer] = doc
    return doc


def _jwks(force_refresh: bool = False) -> dict:
    jwks_uri = _discovery().get("jwks_uri")
    if not jwks_uri:
        raise OidcError("OIDC discovery document has no jwks_uri")
    if not force_refresh:
        cached = _JWKS_CACHE.get(jwks_uri)
        if cached is not None:
            return cached
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
            resp = client.get(jwks_uri)
    except httpx.HTTPError as exc:
        raise OidcError(f"Cannot reach the identity provider JWKS: {exc}") from exc
    if resp.status_code != 200:
        raise OidcError(f"Fetching JWKS failed ({resp.status_code})")
    jwks = resp.json()
    _JWKS_CACHE[jwks_uri] = jwks
    return jwks


def redirect_uri() -> str:
    settings = get_settings()
    return f"{settings.app_public_url.rstrip('/')}/api/auth/oidc/callback"


def make_pkce() -> tuple[str, str]:
    # verifier: 43-128 chars of url-safe entropy; challenge: base64url(sha256(verifier)) no padding.
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def build_authorize_url(state: str, code_challenge: str, nonce: str) -> str:
    settings = get_settings()
    endpoint = _discovery().get("authorization_endpoint")
    if not endpoint:
        raise OidcError("OIDC discovery document has no authorization_endpoint")
    params = {
        "response_type": "code",
        "client_id": settings.oidc_client_id,
        "redirect_uri": redirect_uri(),
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    query = httpx.QueryParams(params)
    sep = "&" if "?" in endpoint else "?"
    return f"{endpoint}{sep}{query}"


def exchange_code(code: str, code_verifier: str) -> dict:
    settings = get_settings()
    endpoint = _discovery().get("token_endpoint")
    if not endpoint:
        raise OidcError("OIDC discovery document has no token_endpoint")
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(),
        "client_id": settings.oidc_client_id,
        "client_secret": settings.oidc_client_secret,
        "code_verifier": code_verifier,
    }
    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
            resp = client.post(endpoint, data=data)
    except httpx.HTTPError as exc:
        raise OidcError(f"Token exchange could not reach the identity provider: {exc}") from exc
    if resp.status_code != 200:
        raise OidcError(f"Token exchange failed ({resp.status_code})")
    return resp.json()


def validate_token(access_token: str, nonce: str | None = None) -> dict:
    # Signature + issuer + exp against the realm JWKS. Audience is intentionally not checked
    # (Keycloak access-token aud is unreliable); the client-role check in extract_identity is the
    # real authorisation gate. nonce is accepted for symmetry with the id_token flow but the
    # access token does not carry it, so it is not enforced here.
    settings = get_settings()
    try:
        header = jwt.get_unverified_header(access_token)
    except Exception as exc:
        raise OidcError("Malformed access token") from exc
    kid = header.get("kid")

    def _key_for(jwks: dict) -> dict | None:
        for key in jwks.get("keys", []):
            if key.get("kid") == kid:
                return key
        return None

    jwks = _jwks()
    key = _key_for(jwks)
    if key is None:
        # Key rotation: the signing kid may be newer than our cache. Refetch once before failing.
        jwks = _jwks(force_refresh=True)
        key = _key_for(jwks)
    if key is None:
        raise OidcError("No matching signing key for the access token")

    try:
        claims = jwt.decode(
            access_token,
            key,
            algorithms=["RS256"],
            issuer=settings.oidc_issuer.rstrip("/"),
            options={"verify_aud": False},
        )
    except Exception as exc:
        raise OidcError(f"Access token validation failed: {exc}") from exc
    return claims


def extract_identity(claims: dict) -> tuple[str, str]:
    settings = get_settings()
    email = (claims.get("email") or claims.get("preferred_username") or "").strip()
    if not email:
        raise OidcError("Your account has no email; cannot sign you in")
    roles = claims.get("resource_access", {}).get(settings.oidc_client_id, {}).get("roles", [])
    roles = [str(r).lower() for r in roles]
    if "admin" in roles or "administrator" in roles:
        role = "admin"
    elif "developer" in roles:
        role = "developer"
    elif "support" in roles:
        role = "support"
    else:
        raise OidcError("Your account has no Infra Monitor role")
    return email, role
