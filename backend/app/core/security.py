from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import jwt
from passlib.context import CryptContext

from app.core.config import get_settings


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
ALGORITHM = "HS256"
bearer_scheme = HTTPBearer(auto_error=False)

# Loopback hosts that qualify for desktop guest access. A network client can never present one
# of these as its source address, so guest access can never leak onto the LAN.
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}

# The email of the real, seeded guest account (role "guest"). It is deliberately NOT the
# subject the desktop synthetic session carries (guest_claims -> "guest@localhost"): the seeded
# row exists so admins can see/manage the guest role in User Management and so the "guest" menu
# row has a home, while the desktop auto-login remains a separate, login-less loopback session.
# The seeded account's password is a random unusable hash, so no one can log in as it.
SEEDED_GUEST_EMAIL = "guest@local"


def is_loopback_client(host: str | None) -> bool:
    return (host or "") in _LOOPBACK_HOSTS


def guest_claims() -> dict:
    # A local desktop guest is given admin so every feature works on the machine's own DB; the
    # `guest` marker lets the UI show a "Guest" state and offer sign-in. Never minted for a
    # network client (see the loopback gate in the callers).
    return {"sub": "guest@localhost", "role": "admin", "guest": True}


def _guest_allowed(request: Request) -> bool:
    settings = get_settings()
    return settings.desktop_mode and is_loopback_client(request.client.host if request.client else None)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def create_access_token(subject: str, role: str) -> str:
    settings = get_settings()
    expires = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    if role == "administrator":
        role = "admin"
    return jwt.encode({"sub": subject, "role": role, "exp": expires}, settings.jwt_secret, algorithm=ALGORITHM)


# Websockets cannot carry an Authorization header, so the shell endpoint validates a token
# it receives in the first frame. Returns None instead of raising: the caller has already
# accepted the socket and must close it with a code rather than emit an HTTP error.
def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, get_settings().jwt_secret, algorithms=[ALGORITHM])
    except Exception:
        return None


def require_user(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)) -> dict:
    # An empty/whitespace token counts as "no token": the desktop UI sends `Bearer ` (empty) in
    # guest mode, and that must take the guest path, not fail token decoding.
    token = credentials.credentials.strip() if credentials else ""
    if not token:
        if _guest_allowed(request):
            return guest_claims()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing access token")
    try:
        return jwt.decode(token, get_settings().jwt_secret, algorithms=[ALGORITHM])
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token") from exc


def require_admin(claims: dict = Depends(require_user)) -> dict:
    if claims.get("role") not in {"admin", "administrator"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return claims


def require_admin_or_developer(claims: dict = Depends(require_user)) -> dict:
    if claims.get("role") not in {"admin", "administrator", "developer"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin or developer role required")
    return claims


def require_admin_not_guest(claims: dict = Depends(require_admin)) -> dict:
    # A desktop guest is admin for operating servers but is not an account and must not touch the
    # RBAC system (users, policies). Sign in as a real admin for those.
    if claims.get("guest"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not available in guest mode. Sign in to manage users and policies.")
    return claims
