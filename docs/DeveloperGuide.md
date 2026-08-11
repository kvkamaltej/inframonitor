# Developer Guide

## Layout

```
backend/
  app/
    main.py               app assembly, lifespan startup, /health, static mount
    api/routes.py         every /api route
    core/config.py        pydantic-settings, reads .env
    core/database.py      engine, SQLite pragmas, get_db
    core/security.py      bcrypt hashing, JWT, role dependencies
    core/crypto.py        Fernet helper keyed off JWT_SECRET
    models/entities.py    SQLAlchemy ORM models
    schemas/contracts.py  Pydantic request/response schemas
    services/ssh_ops.py   paramiko: discovery, vitals probe, containers, logs, Tomcat,
                          privileged ops, and ShellSession (the interactive PTY)
    services/inventory.py inventory helpers
    services/csv_import.py bulk import parsing and validation
    services/integrations.py optional monitoring probes
  tests/                  pytest
  requirements.txt
frontend/
  app/                    Next.js App Router pages
  components/             the UI; one large component per page
  lib/api.ts              the single fetch wrapper
monitoring/               full profile only: prometheus, alertmanager, loki, promtail, grafana config
scripts/                  stack, preflight, deploy, healthcheck, backup, restore, upgrade
Dockerfile                multi-stage: node builds the UI, python runs it
docker-compose.yml        lite: one service. The default.
docker-compose.full.yml   overlay: adds postgres + 5 monitoring services, rewrites app's env
```

Two install profiles, one image and one codebase — see [Deployment.md](Deployment.md#choosing). Nothing
in `backend/` or `frontend/` branches on the profile; the only differences reach the app as environment
variables (`DATABASE_URL`, `METRICS_ENABLED`, the four monitoring URLs).

The backend is FastAPI + SQLAlchemy + Pydantic with sync route handlers (FastAPI runs them on a
threadpool). The frontend is Next.js App Router + TypeScript + Tailwind, built as a **static export** —
there is no Node.js server at runtime and no server-side rendering of API data.

Two consequences of the static export that you will hit if you touch the terminal:

- **`components/shell-panel.tsx` must import xterm.js dynamically.** xterm touches `window` at module
  scope, which throws during the export's prerender pass. A static top-level `import` of it breaks
  `next build`, not just the dev server, so the failure shows up late.
- **The shell is the one route that is not a REST call through `lib/api.ts`.** It is a WebSocket; `lib/api.ts`
  provides `shellSocketUrl()` and `shellHandshake()` for it, and the token travels in the first frame because
  a browser cannot set an `Authorization` header on a WebSocket. Keep both halves of the wire protocol
  (`{"d": ...}` for keystrokes, `{"r": [cols, rows]}` for resize, raw text back) in step between
  `shell-panel.tsx` and the handler in `api/routes.py`. The favorites and SFTP routes beside it are ordinary
  REST calls and go through `lib/api.ts` like everything else.

One more thing about the terminal, which is a workspace rather than a single panel:

- **Do not conditionally render a hidden tab's terminal body.** Unmounting an xterm instance is what makes
  it lose its scrollback and drop its socket, so an inactive tab must stay mounted and be hidden with CSS.
  Every tab is a live session; switching tabs is a visibility change, not a teardown. `shell-panel.tsx`
  hides them with `invisible` rather than `display:none` on purpose — `invisible` keeps the layout box, so a
  background terminal still measures a real size and refits correctly.
- **Re-fit after the layout settles, not before.** `FitAddon.fit()` has to run *after* entering or leaving
  fullscreen, after a tab switch, and after entering or leaving split view, once the container has its final
  size — calling it too early sizes the emulator to the old geometry and the terminal renders at the wrong
  dimensions. In split view **both** terminals need re-fitting, not just the newly revealed one: the pane
  that was already visible changed width too.
- **The re-fit schedule arms an `requestAnimationFrame` *and* a timer, and it needs both.** rAF callbacks do
  not run in a hidden browser tab, so a layout change that happens while the workspace is backgrounded would
  never be picked up by an rAF alone — that was a real bug. Keep both arms if you touch that code.
- **Fullscreen is the browser Fullscreen API, with the old in-page overlay as a fallback.**
  `element.requestFullscreen()` returns a promise **that can reject** (no user gesture, blocked by policy,
  an iframe without `allow="fullscreen"`), so the rejection has to be handled by falling back to the overlay
  rather than leaving the UI asserting a state the document is not in.
- **Drive fullscreen state from the `fullscreenchange` event, not from the click handler.** The browser's own
  `Esc` exits fullscreen without going through the button, so state set optimistically on click desyncs the
  label. The manual `Esc` handler and the event listener must not both toggle for one keypress.
- **`preventDefault()` a context menu on the element that owns it, never on the document.** The tab-chip and
  file-row menus suppress the native menu on the chip/row only; the rest of the page, including the
  terminal, keeps its normal right-click. A menu also needs a keyboard path (`⋯` button, `Shift+F10`, the
  `ContextMenu` key), since right-click alone is not accessible.

## Local dev loop

The container serves a pre-built UI, which is right for production and wrong for iterating on the UI.
So run the two halves separately in development.

### Backend

```bash
cd backend
python -m venv .venv && . .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt

export JWT_SECRET=dev-only-not-a-real-secret      # Windows: $env:JWT_SECRET="..."
uvicorn app.main:app --reload --port 8000
```

That gives you the API on `http://localhost:8000`, with `/docs` for poking at it. The database is
created at `backend/data/inframonitor.db` — `DATABASE_URL` is relative (`sqlite:///./data/inframonitor.db`), so it
resolves under whatever directory you started uvicorn from. The startup hook creates the tables and
seeds `admin@inframonitor.local` / `ChangeMe123!` (or your `ADMIN_EMAIL` / `ADMIN_PASSWORD`), same as in the
container — and logs the default-credentials banner until you change the password.

Local dev is the lite shape. To develop against Postgres, run one and set
`DATABASE_URL=postgresql+psycopg://...`; `core/database.py` branches on the dialect, so nothing else
changes. Set `METRICS_ENABLED=true` if you need `/metrics` locally — it is not registered otherwise.

Two things to know:

- The static mount is skipped when the directory does not exist, so a checkout with no UI build starts
  fine and just serves the API.
- Use `--reload` but **not** `--workers`. `create_all` and the migration step are not concurrency-safe
  and SQLite has one writer.

#### The shell needs the `websockets` package

`websockets` is a **required** entry in `requirements.txt`, not an optional extra. **Plain `uvicorn` ships
no WebSocket protocol implementation at all.** Without the package installed, `WS /api/servers/{id}/shell`
is not served: the upgrade request falls through and the browser gets a bare **HTTP 404** — no close code,
no error message, nothing pointing at the real cause. Every shell session fails, and the endpoint looks
missing rather than unsatisfiable.

So do not treat it as trimmable when producing a minimal install, and do not remove it if you are pruning
dependencies. `uvicorn[standard]` would also supply it, but it drags in `uvloop`, `httptools` and
`watchfiles`, which is why the pinned `websockets` is listed on its own instead.

If the shell 404s, check this before anything else:

```bash
python -c "import websockets; print(websockets.__version__)"
```

A `ModuleNotFoundError` there is the whole problem. A close code — `4401`, `4403`, `4404`, `4429`, `4500` —
means the route *is* being served and the cause is something else; see
[Troubleshooting.md](Troubleshooting.md#the-interactive-shell-will-not-open).

### Frontend

```bash
cd frontend
npm ci                    # the lockfile is authoritative; npm install ignores it
npm run dev               # http://localhost:3000
```

`next dev` gives you hot reload. Because it runs on a different origin from the API, point it at your
uvicorn and let the backend allow it:

```bash
# frontend/.env.local
NEXT_PUBLIC_API_URL=http://localhost:8000/api
```

```bash
# backend, so CORS middleware is installed
export CORS_ORIGINS=http://localhost:3000
```

In production neither variable is set: `lib/api.ts` falls back to a relative `/api`, and with
`CORS_ORIGINS` empty no CORS middleware is added at all, because same-origin does not need it.

### Producing what the container serves

```bash
cd frontend
npm run build             # next build → out/
```

`next.config.mjs` sets `output: "export"` and `trailingSlash: true`, so `next build` emits a fully
static `out/` directory. The Dockerfile copies that to `/app/static`, and `main.py` mounts it with
`StaticFiles(html=True)` **after** the router so `/api/*`, `/health` and `/docs` still win.

To check the real thing locally, build the UI, copy `out/` to `backend/static/`, and run uvicorn — you
then get the production same-origin layout on one port.

`npm start` (`next start`) is not used. A static export has no Node server.

### Static export constraints

Worth internalising before adding a page:

- **No dynamic route segments.** Nothing can prerender `/servers/[id]` without enumerating every id,
  which is why the detail page is `/server/?id=<public_id>`, read with `useSearchParams()`.
- **`useSearchParams()` must sit inside a `<Suspense>` boundary**, or the export build fails with
  "useSearchParams() should be wrapped in a suspense boundary".
- No route handlers, no middleware, no server actions, no `next/image` optimisation at runtime.
- `trailingSlash: true`, so links are `/server/`, not `/server`.

`eslint.ignoreDuringBuilds` is on. Turning it off surfaces a backlog of warnings and blocks the build;
if you want to clean that up, do it as its own change.

## Tests and checks

```bash
cd backend && pytest                 # tests/ — currently a /health smoke test
python -m py_compile app/**/*.py     # syntax check anything you touched

cd frontend && npx tsc --noEmit      # must pass
npx next build                       # must produce out/, including out/server/index.html
```

`out/server/index.html` existing is the proof that the query-param detail route exported correctly.

In the container:

```bash
docker compose exec app pytest       # only if you add the dev deps to the image
docker compose logs -f app
docker compose up -d --build
```

## Conventions

- Route handlers stay thin: validate, call a service, map to a schema. SSH and parsing logic lives in
  `services/ssh_ops.py`.
- Every server-scoped route resolves its target through `_server_or_404(db, server_id, claims)` so the
  per-server ACL is enforced in one place. Do not query `Server` directly in a new route.
- Pick the narrowest role dependency that works: `require_user`, `require_admin_or_developer`,
  `require_admin`.
- Never return a credential value in a response, and never log one. Sudo passwords are pass-through
  only: SSH stdin, never a command line, never stored.
- Anything reading a remote file path must go through the discovered-log-path allowlist. That check is
  what stops the log endpoints being an arbitrary file read.
- Adding a column to `servers`? Add it to `EXPECTED_SERVER_COLUMNS` in `main.py` with a type valid in
  **both** dialects (`TEXT`, `VARCHAR(n)`, `INTEGER`, `TIMESTAMP`) and a default, or existing databases
  will not get it. `create_all` only handles fresh ones.
- **Write SQL that works on SQLite *and* Postgres.** The full profile runs Postgres, so the intersection
  is what you get: no `ADD COLUMN IF NOT EXISTS` (SQLite lacks it), no `TIMESTAMPTZ` or server-side
  sequences (SQLite lacks those), and no SQLite-only pragmas or `INSERT OR REPLACE` in shared code.
  Prefer SQLAlchemy constructs over raw SQL for anything new. Engine-level differences belong in
  `core/database.py`, which already branches on dialect — SQLite gets `check_same_thread` plus the
  WAL/foreign-keys pragmas, anything else gets a plain engine.
- **Still one worker in both profiles.** The startup schema/migration step is not concurrency-safe. That
  constraint is the startup path, not the engine, so Postgres does not relax it.
- Adding a route? Its **template** becomes a metrics label in full mode. Keep path parameters as
  parameters (`/{server_id}`) — never build a route whose template varies per resource, or you multiply
  the metric's cardinality.
- All frontend API calls go through `lib/api.ts`. Do not `fetch` directly from a component.
