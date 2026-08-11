from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import jwt
from passlib.context import CryptContext

from app.core.config import get_settings


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
ALGORITHM = "HS256"
bearer_scheme = HTTPBearer(auto_error=False)


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


def require_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)) -> dict:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing access token")
    try:
        return jwt.decode(credentials.credentials, get_settings().jwt_secret, algorithms=[ALGORITHM])
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
