from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PLACEHOLDER_SECRETS = {
    "change_this_secret_before_production",
    "changeme",
    "secret",
}


class Settings(BaseSettings):
    app_name: str = "Infra Monitor"
    # lite: sqlite file. full: postgresql+psycopg://inframonitor:...@postgres:5432/inframonitor
    database_url: str = "sqlite:///./data/inframonitor.db"
    jwt_secret: str
    access_token_expire_minutes: int = 480
    cors_origins: str = ""
    static_dir: str = "static"
    prometheus_url: str = ""
    grafana_url: str = ""
    loki_url: str = ""
    alertmanager_url: str = ""

    # Bearer token Prometheus presents when scraping GET /api/monitoring/prometheus/targets
    # (the http_sd endpoint). When empty the endpoint is left unauthenticated so a dev stack
    # works out of the box; set MONITORING_SD_TOKEN in any real deployment and configure the
    # same value as Prometheus's http_sd_configs[].authorization.credentials.
    monitoring_sd_token: str = ""

    # How often the background log-shipping driver tails managed servers into Loki, in seconds.
    # The driver is skipped entirely when loki_url is empty (lite profile). 0 or a negative value
    # disables the periodic driver even when Loki is configured.
    log_ship_interval_seconds: int = 30

    # How often the background Kubernetes log-shipping driver tails pod logs into Loki, in seconds.
    # Mirrors log_ship_interval_seconds (default 30): skipped when loki_url is empty, disabled at
    # <= 0, and a harmless no-op every sweep until some cluster has log shipping enabled -- so it
    # defaults ON, exactly like the server driver, and starts shipping the moment a cluster opts in.
    k8s_log_ship_interval_seconds: int = 30

    # Where the app writes user-defined Prometheus alert rules. Shared with the Prometheus
    # container via the custom_rules volume (see docker-compose.full.yml). The app must be able
    # to write it -- the Dockerfile chowns /app/custom-rules to the runtime uid. Empty falls back
    # to a sensible in-container default.
    custom_rules_path: str = "/app/custom-rules/custom.yml"

    # /metrics is off in lite mode and the route is not registered at all; full mode
    # sets METRICS_ENABLED=true so Prometheus has something to scrape
    metrics_enabled: bool = False

    # Desktop app only: when true, an unauthenticated request FROM LOOPBACK is served as a
    # full-access local "guest" (no login wall on your own machine). The desktop launcher sets
    # DESKTOP_MODE=1; the server deployment never does, so network access always requires login.
    # The loopback check in security.py is a second gate: even if this were mistakenly set on a
    # 0.0.0.0-bound instance, a request arriving via a LAN IP still gets no guest access.
    desktop_mode: bool = False

    # first-boot admin seed. Overridable so an operator can avoid the shipped default
    # entirely; while the default password is still in force the app prints a banner
    # on every boot (see app.main._warn_if_default_admin_password)
    admin_email: str = "admin@inframonitor.local"
    admin_password: str = "ChangeMe123!"

    # only used in the default-credentials banner, so the operator is told where to log in
    public_url: str = "http://localhost:8088"

    # --- optional Keycloak / OIDC single sign-on -----------------------------------------
    # All additive: when oidc_issuer/client_id/client_secret are unset the app behaves exactly
    # as before (local bcrypt login only). Set all three to enable the Authorization Code + PKCE
    # login (BFF) in app.services.oidc. oidc_issuer is the realm base, e.g.
    # http://192.168.1.50:8080/realms/ecil (the /.well-known/openid-configuration lives under it).
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    # The browser-facing base URL of THIS app (e.g. http://192.168.1.41:8088). Used to build the
    # OIDC redirect_uri and the post-login redirect back to the SPA. Distinct from public_url,
    # which only feeds the default-credentials banner.
    app_public_url: str = ""

    # upload cap for WAR deployment; also the cap for SFTP uploads
    max_war_mb: int = 512

    # cap for SFTP downloads, checked against the remote stat before any bytes are read
    max_download_mb: int = 200

    # --- interactive shell session limits ------------------------------------------------
    # All four were hardcoded in api/routes.py. On both time caps, 0 means "no limit" -- see
    # _shell_limit_minutes there, which turns a 0 into None rather than a 0-second threshold.
    #
    # 480 minutes is deliberately the same number as access_token_expire_minutes above. The
    # shell WebSocket validates its token once, at the handshake, and never re-checks it: there
    # is no mid-session revalidation and no refresh. Without an absolute cap a session therefore
    # keeps running long after the JWT that authorised it has expired -- for as long as the
    # browser tab stays open. Matching the token lifetime is what keeps "a shell lives at most
    # as long as the credential that opened it" true.
    #
    # Setting SHELL_MAX_MINUTES=0 removes that cap, and accepts exactly that trade: sessions
    # that outlive their own token indefinitely, until someone closes the tab or the API process
    # restarts. That can be the right call for a long migration or a multi-hour tail -- it is
    # just worth knowing it is the guarantee being given up.
    shell_max_minutes: int = 480

    # idle cap. 0 = no limit; a session then survives any amount of inactivity, bounded only by
    # shell_max_minutes (or by nothing at all, if that is 0 too).
    shell_idle_minutes: int = 30

    # concurrency ceilings, global and per user. Not "0 = unlimited": these count sessions, and
    # 0 means zero sessions are permitted, which is a usable way to turn the shell off entirely.
    shell_max_sessions: int = 24
    shell_max_sessions_per_user: int = 8

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # jwt_secret signs tokens AND derives the Fernet key for stored SSH credentials, so a
    # known or guessable value exposes every managed server's password and private key
    @field_validator("jwt_secret")
    @classmethod
    def _reject_weak_secret(cls, value: str) -> str:
        secret = value.strip()
        if not secret:
            raise ValueError("JWT_SECRET must be set")
        if secret.lower() in PLACEHOLDER_SECRETS:
            raise ValueError(
                "JWT_SECRET is still the example placeholder. Generate one with: "
                'python -c "import secrets; print(secrets.token_urlsafe(48))"'
            )
        if len(secret) < 32:
            raise ValueError("JWT_SECRET must be at least 32 characters")
        return secret

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def oidc_configured(self) -> bool:
        # OIDC login is live only when all three secrets are present; any missing one leaves the
        # app on the local-login-only path it has always had.
        return bool(self.oidc_issuer.strip() and self.oidc_client_id.strip() and self.oidc_client_secret.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
