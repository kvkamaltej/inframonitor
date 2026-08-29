# Infra Monitor Usage

## Sign in

There is one URL for everything:

- URL: `http://<host>:8088` (the port is `APP_PORT`, default `8088`)
- Email: `admin@inframonitor.local`
- Password: `ChangeMe123!`

These are the defaults for both install profiles. If the operator set `ADMIN_EMAIL` / `ADMIN_PASSWORD`
in `.env` before the first boot, use those instead.

Change that password on first use — the **Profile** page in the sidebar, or
`POST /api/auth/change-password`. It is a published default.

**While your account still has the default password, every page shows a warning banner**
("This account still uses the default password") linking to `/profile`. You can dismiss it, but **it comes
back after 24 hours and on your next sign-in** — dismissing buys quiet for the rest of the session, not
silence. The only way to be rid of it is to change the password. The app also prints a banner naming the
email, password and URL to its container log on every boot while the default is in force —
`docker compose logs app`. Both stop once the password is changed.

There are no other logins to Infra Monitor. The UI, the API and the Swagger docs at `/docs` are all served by the
same process on the same port, and all use this account. (In the full profile, Grafana on port 13000 has
its **own separate** account — see [Monitoring.md](Monitoring.md#credentials).)

## Add Servers

Use the Add Server form on the Server Management page as an admin. It asks for SSH password or private
key so the backend can store credentials encrypted and discover OS/runtime/database/storage details.

The form is a six-column grid on wider screens: hostname, IP address, SSH user, SSH port, environment and
server type take the first row one column each; **SSH password** and **tags (comma separated)** then share
the next row at half width each; and **SSH private key** takes a full-width row of its own, since it is a
multi-line paste target that should not share. The fields themselves are unchanged — the layout moved, not
what is submitted.

Credentials are required for live Docker/Podman container listing and logs. They are not shown in the
inventory table, and no API response ever returns them.

You can also call the API. `POST /api/servers` is **admin-gated**, so you must log in first and send
the bearer token — without an `Authorization` header the call returns `401 Missing access token`:

```bash
TOKEN=$(curl -s -X POST http://localhost:8088/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@inframonitor.local","password":"ChangeMe123!"}' | jq -r .access_token)

curl -X POST http://localhost:8088/api/servers \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"hostname":"db-01","ip_address":"192.168.1.30","username":"ems","ssh_port":22,"environment":"Production","tags":["database","postgresql"]}'
```

Every endpoint except `POST /api/auth/login` needs that bearer token, and several also need a specific
role. See [API.md](API.md) for the full table.

Adding a server registers the inventory record and runs live SSH discovery when credentials are
supplied. Discovery detects OS flavour, Docker, Podman, common databases, common web/app services,
Tomcat instances, database log files, and mounted filesystems.

## Import Servers from CSV

To onboard many servers at once, open Server Management as an admin and click **Import from CSV** next
to Add Server. Choose a `.csv` file or paste the text; the header must contain at least `hostname`,
`ip_address` and `username`, and `password` / `private_key` are optional and stored encrypted.

The panel is a two-step flow. **1. Dry run** validates every row and writes nothing; **2. Import
servers** stays disabled until the dry run passes, and re-disables itself if you edit the CSV
afterwards. The result lists every row as `valid` / `created` / `skipped` / `failed` with a reason, and
a successful import refreshes the inventory table behind the panel.

Two things to keep in mind:

- The CSV holds plaintext SSH credentials. Delete it after the import, keep it out of git, and do not
  email it.
- Import does **not** run SSH discovery. Imported servers land with status `unknown` and no OS/service
  data until you run discovery on each one.

- A `group` column puts each row straight into a group, creating the group if it does not exist yet,
  so a fleet arrives already organised rather than all in **Unassigned**.

Full column list, defaults, the `;` convention for tags, the `\n` convention for private keys,
duplicate handling, and a worked example are in [CsvImport.md](CsvImport.md).

## Export the inventory to Excel

**Server Management -> ... -> Export to Excel** downloads the whole inventory you can see as an `.xlsx`
workbook (`server-inventory-<timestamp>.xlsx`). Available to every role, not just admins; a non-admin
gets exactly the servers they have access to, the same rule the inventory table follows.

The sheet has a frozen, filterable header row and one row per server: hostname, alias, IP, SSH port,
username, group, environment, type, status, OS, kernel, architecture, CPU and CPU %, RAM and RAM used,
disk, uptime in hours, health score, Docker version, tags, business owner, support contact, whether
metrics are enabled, and when it was last checked.

**Passwords and private keys are never exported.** The only credential information in the file is a
`Credentials` column reading `Yes`/`No`, so the workbook is safe to hand to someone who should not hold
the fleet's secrets. The export ignores the current filters on purpose -- a spreadsheet quietly missing
rows is a worse failure than a few extra ones.

## The inventory table

The Server Management page lists every server you can reach. Its columns are **Host**, **IP**, **OS**,
**Uptime**, **CPU**, **RAM**, **Procs**, **Type**, **Environment**, **Status**, and — for admins only —
**Actions**.

Things worth knowing about it:

- **There is no Credentials column.** It was removed: it only ever restated the boolean now shown by
  whether the row's admin actions are enabled, and no credential value has ever been displayed anywhere.
- **Uptime replaced the old Runtime column**, in the same position. It reads as `3d 18h`, dropping to
  `18h 42m` and then `42m` on a recently booted host, and carries the load average underneath it once one
  has been sampled.
- **CPU, RAM and Procs are the vitals columns**, described below. A dash means no reading, never zero.
- **Filter by type and environment.** The dropdowns are built from the distinct values actually present in
  the loaded inventory, not a fixed list, so they only ever offer values you use. Both have an "All"
  state, and the page shows how many of how many rows are currently visible.
- **Sort by IP address** from the column header. The sort is **numeric per octet**, not lexical, so
  `10.0.0.9` comes before `10.0.0.10` — which a plain string sort gets backwards. Addresses that are not
  IPv4 (IPv6, or a hostname typed into the IP field) fall back to a plain string comparison rather than
  failing.

### Vitals: uptime, CPU, RAM and process count

These four columns are a **point-in-time SSH probe, not continuous monitoring.** Nothing samples them on a
timer, nothing keeps history, and nothing alerts on them. A value is exactly as old as the moment someone
last asked for it.

| Column | Field | Source on the host |
| --- | --- | --- |
| Uptime | `uptime_seconds` (plus `load_average` beneath) | `/proc/uptime`, `/proc/loadavg` |
| CPU | `cpu_percent` | two `/proc/stat` reads 1 s apart |
| RAM | `ram_used_mb` against `ram_mb` | `/proc/meminfo` (`MemTotal - MemAvailable`) |
| Procs | `process_count` | `ps -e` |

`vitals_checked_at` on the server record is when the sample was taken. Treat it as the freshness stamp:
the numbers do not expire or grey out on their own, so an untouched row can show figures from days ago.

**A dash is not a zero.** `cpu_percent` is `-1` until the host has been probed at least once, and the UI
renders that as `-`. This matters: a genuinely idle server shows `0%`, and an unprobed one shows `-`. Do
not read one as the other.

Two ways to populate them:

- **Running discovery** folds a vitals sample in, because it already has an open SSH connection.
- **The `Refresh vitals` button** above the table probes the hosts in the inventory over SSH. It is the
  only control on the page that reaches out to hosts.

Refreshing costs about **two seconds per host**, most of it the deliberate 1-second gap between the two
CPU samples (`/proc/stat` is cumulative since boot, so a single read would report the average since boot
rather than the load now). The page runs at most **4 probes concurrently**, so a 40-server inventory takes
roughly 20 seconds rather than 40 opening at once. It is a foreground action with a visible progress
state; it is not something the page does on load.

A host with no stored credentials cannot be probed, and a host that is unreachable keeps its previous
numbers and its old `vitals_checked_at`.

### The shell workspace

The **Shell** button in the Actions column opens the shell workspace, a terminal panel above the table.
It is **admin-only** and disabled when the server has no stored credentials.

This is the most powerful thing in the product. Each tab is a PTY as the **stored SSH user**, with all of
that user's privileges and no command filtering — including `sudo` wherever that user is allowed it. Anyone
who can open it can do anything that SSH account can do. Limits you will actually notice per session:
**30 minutes** of idle time and **8 hours** maximum however busy you are — both defaults your operator can
change or switch off, see [Session limits](#session-limits-and-can-a-session-last-longer-than-an-hour).

#### Tabs

The workspace holds **several sessions at once**, one per tab, and they run concurrently rather than
replacing each other:

- Tabs to **the same host** are allowed — two shells on `ems-41` is a normal thing to want, and duplicates
  are disambiguated in the label (`ems-41`, `ems-41 (2)`).
- Tabs to **different hosts** live in the same strip, so you can work across machines without leaving the
  page.
- Each tab carries **its own connection state** (connecting, open, closed, error), so a tab whose session
  has died is visibly dead rather than silently inert.
- Switching tabs does **not** disconnect the tab you are leaving. Hidden sessions stay connected and keep
  their scrollback; only closing a tab closes its socket. Closing the workspace closes all of them.

Each tab is a separate SSH session and counts separately against the concurrency caps below.

#### The tab menu

Each tab chip has a menu with four actions:

| Action | What it does |
| --- | --- |
| **Duplicate tab** | Opens a **new session to the same host** — the same thing as picking that host from the New-tab control. It is a second, independent PTY, not a second view of the first one: it has its own shell, its own working directory and its own scrollback, and it counts as another session against the caps. |
| **Split with this tab** | Shows this session **alongside** the active one — see [Split view](#split-view). On a tab that is already one of the two showing, this item reads **Exit split** instead and returns to a single terminal. |
| **Close tab** | Closes that tab and its socket. |
| **Close other tabs** | Closes every other tab, keeping this one. Disabled when there is only one tab. |

Open it by **right-clicking the chip**, or from the **`⋯` button on the chip** — and the `⋯` button is
keyboard-reachable, so the menu is not right-click-only. With the chip focused, the **`Menu`/`ContextMenu`
key** or **`Shift+F10`** opens it too. It closes on **`Esc`**, on a click elsewhere, and on scroll or resize,
and it is positioned so it stays on screen at the right-hand end of the strip. Closing it puts keyboard focus
back in the active terminal, so you are not left typing into nothing.

Right-clicking a tab chip suppresses the browser's own context menu **on the chip only** — right-click
still works normally everywhere else on the page, **including inside the terminal**, where the native menu is
how you reach copy and paste.

#### Split view

Split shows **two sessions side by side** — stacked one above the other on a narrow screen — so you can
watch a log in one and work in the other without switching tabs. Reach it from a tab's menu, or from the split
button in the workspace toolbar, which toggles back out again.

- **Only one of the two has keyboard focus.** The focused pane is outlined and labelled *"focused — typing
  goes here"*, and the other says *"click to focus"*. Keystrokes go to the focused one and nowhere else,
  which is why the workspace never lets the pair on screen and the keyboard target disagree.
- **Clicking a third tab's chip swaps it into the focused slot** rather than dropping the split or leaving
  the tab invisible.
- Both terminals are **re-fitted** when you enter or leave split and when the window changes size, so
  neither renders at a stale size.
- **Closing either of the two drops back to single**, with the survivor focused. If one of the pair goes away
  for any other reason the layout converges back to single by itself — a split with one live session in it is
  not a state you can get stuck in.
- Nothing is disconnected by entering or leaving split. Sessions that are not visible stay live, exactly as
  with ordinary tab switching.

#### Fullscreen

Fullscreen uses the **browser's own fullscreen mode**, so the workspace covers the **whole screen** — the
browser's tabs, address bar and window frame all go away, and the terminal runs edge-to-edge with the inner
padding and rounded corners removed. The tab strip and the side pane stay usable.

Leave it with **`Esc`** or the button; both stay in step, so the button never says "Exit fullscreen" while
you are no longer in it, or the reverse.

If your browser **refuses** the fullscreen request — some do when the click is not treated as a user
gesture, and it can be disabled by policy or in a restricted iframe — the workspace falls back to the older
behaviour of expanding to fill the browser viewport instead. You get the space inside the window rather
than the whole screen; nothing breaks, and `Esc` still exits.

The terminal is re-fitted **after** the switch completes, on entering and on leaving, and on switching tabs,
so the emulator's idea of the window matches what you see.

#### Concurrency caps, and telling the two refusals apart

Two caps apply: **24 sessions across the whole application** and **8 per user** by default. A refused
session closes with code `4429`, and the close reason distinguishes the two cases, because the fix is
different:

- **Your own limit** — you already hold your maximum number of sessions. Close one of your own tabs; nobody
  else can help.
- **Application capacity** — the application-wide maximum is open across all users. Your own tabs are not
  the problem; wait for someone else's session to end.

Both numbers are configurable (`SHELL_MAX_SESSIONS`, `SHELL_MAX_SESSIONS_PER_USER`), so the figures on your
install may differ. The close reason states the actual limit.

#### Session limits, and "can a session last longer than an hour?"

**Yes.** By default a session is closed after **8 hours** in total, or after **30 minutes** with no
activity, and when that happens the close reason **says which limit ended it** rather than leaving you
guessing.

All four limits are settings your operator controls:

| Limit | Env | Default |
| --- | --- | --- |
| Total session duration | `SHELL_MAX_MINUTES` | `480` (8 hours) |
| Idle time | `SHELL_IDLE_MINUTES` | `30` |
| Sessions application-wide | `SHELL_MAX_SESSIONS` | `24` |
| Sessions per user | `SHELL_MAX_SESSIONS_PER_USER` | `8` |

Setting either time limit to **`0` turns it off** — no duration cap, or no idle cap, at all. That is
available for a reason: an upgrade, a migration or a large `rsync` can legitimately run longer than eight
hours, and a session killed part-way through one is worse than a session that lived too long.

There is a real trade-off behind switching the duration cap off, and the operator making that change should
read [Deployment.md](Deployment.md#why-the-default-is-480-and-what-shell_max_minutes0-accepts): your login
token is checked **once**, when the terminal connects, and never again while the session is open, so the
duration cap is the only thing that stops a terminal running long after the credential that opened it has
expired.

One practical note: if your install is behind a reverse proxy, the **proxy's** idle timeout can be shorter
than the app's, and then it — not Infra Monitor — is what disconnects you. A session that dies at a
suspiciously round interval that matches nothing in the table above is usually the proxy.

#### Favorite commands

The workspace's side pane keeps a list of saved commands, **per user** — yours are yours, and nobody else
sees or can delete them. Each entry is a name and a command, and the command is **stored exactly as you typed it**;
the product does not rewrite, validate or "sanitise" it, because it is a command destined for your own
shell.

**Clicking a favorite inserts it into the active terminal without running it.** You press Enter yourself.
That is deliberate: a mis-click in a list should not be able to execute something destructive on a
production host.

There is a separate run button if you want it, and it is two-step — the first click arms it and a second
confirms — so executing a saved command is always something you did on purpose rather than something a
stray click did for you.

Saving is a small input you type or paste the command into (prefilled from your selection when you have
one). It cannot read your current prompt line — a terminal emulator has no access to what the remote shell
is holding in its input buffer, so nothing here pretends to capture it.

Names must be unique within your own favorites; reusing one is rejected rather than silently overwriting
the existing entry.

#### The file pane (SFTP)

The workspace's side pane shows either the favorites list or a file browser — one at a time — and the file
browser targets **the active tab's host**, switching with it. It browses, downloads, uploads and deletes over
SFTP as the same SSH user as the terminal.

**Understand what this is before you use it.** It is **arbitrary filesystem access as the stored SSH
user** — the same reach the terminal beside it already gives you, in a point-and-click form. It is
**admin-only**, subject to the same per-server ACL, and **it is not restricted to a subdirectory**: you can
list, fetch and remove anything that SSH account can, anywhere on the host.

- **Every transfer and every delete is recorded.** A download writes an `sftp.download` row, an upload an
  `sftp.upload` row and a delete an `sftp.delete` row to `audit_logs`. Transfers carry the remote path and
  the byte count; deletes carry the path, whether it was recursive, and how many entries were removed.
  *Listing* a directory is not recorded — no data leaves the host when you browse.
- **Size caps.** Downloads are capped by `MAX_DOWNLOAD_MB` (default **200 MB**) and checked against the
  remote file's size *before* any bytes are read, so an oversized file is refused rather than half
  transferred. Uploads reuse the WAR cap, `MAX_WAR_MB` (default **512 MB**). Either way over the limit is
  a **413**.
- **Large directories are capped at 2000 entries**, and the pane says so when a listing was truncated
  rather than presenting a partial directory as if it were complete.
- **No rename or chmod.** Browse, download, upload and delete is the whole set.

##### The row menu

Right-click a row for **Download**, **Delete…** and **Copy path**. As with the tab chips, the same menu is
on a per-row **`⋯` button**, so it is reachable without a right-click and from the keyboard.

##### Deleting

**This removes data from the host, and nothing in Infra Monitor keeps a copy.** There is no trash and no
undo — it is as final as `rm` in the terminal tab, because it is the same thing.

- **Delete…** opens a confirmation showing **the full absolute path** and what is about to be removed. A file
  or a symlink needs only the confirm button.
- **A directory requires you to type its name** into the dialog before the button will act. Not a checkbox —
  a checkbox next to a confirm button is two clicks in the same place, and a stray double-click or a held
  Enter key gets through it. Typing the name does not happen by accident. Deleting a directory from the pane
  always takes the recursive path, so it always asks.
- **`/` is refused**, and so is any recursive delete of a very shallow path such as `/etc`, `/var` or
  `/home`, or of the SSH user's own home directory. For a shallow directory the dialog says so **up front and
  refuses to send the request** rather than letting you type the name and then failing.
- **Deleting a symlink removes the link, not what it points at.** The target directory or file is left
  exactly as it was, and the confirmation message says so explicitly. This is worth knowing when you are
  cleaning up: removing `/opt/app/current` does not touch the release directory it points to.
- On success the listing refreshes and the pane says what was removed, including the total entry count for a
  directory. On failure the dialog closes and a banner explains why — not found, permission denied, too broad
  a path — because an explanation behind a dialog is not an explanation. Retrying means typing the
  acknowledgement again, which for a recursive delete is the point.
- **A very large tree may stop part-way.** One request removes at most 5000 entries and descends at most 32
  levels; past either it stops with an error saying how much it removed. What was removed is gone — there is
  no undo and no rollback — and re-running continues from where it stopped.

##### Sorting

Sort the listing by **name**, **size** or **modified**, ascending or descending. The controls are in the
pane's toolbar rather than on clickable column headers, because the size and modified columns are hidden when
the pane is docked narrow and a control you cannot reach at that width is not a control.

Sorting is on the real values, not the displayed text, so sizes order by actual bytes rather than
alphabetically by their formatted labels ("9 KB" before "10 MB", not after), and dates order chronologically
rather than by month name. Names sort numerically-aware, so `file9` comes before `file10`.

Two details that stop a sort looking broken:

- **Sorting by size keeps directories in name order** and groups them ahead of files. A directory's reported
  size is its inode size, which this pane does not display, and ordering rows by a number nobody can see looks
  like a bug.
- **An entry with an unreadable timestamp sinks to the bottom** in both directions rather than posing as the
  oldest thing in the directory.

**Folders first** is a separate toggle you control. Turning it off lets a sort apply across the whole
listing — which is what you want when you are looking for the largest thing in a directory regardless of
whether it is a file or a folder — rather than having the grouping silently override your sort. With it on,
reversing the direction reverses the order *within* each group and leaves directories at the top, where you
asked for them.

Sorting and the name filter are applied in the browser to the entries that were returned, so on a **truncated**
listing they only cover the entries that loaded, not the rest of the directory. The pane says so when a
listing was cut short.

**You cannot sort by creation time, and this is not something that can be added.** The SFTP protocol's file
attributes carry **modification time, access time, size, permissions and ownership — and no creation
time at all.** The server never sends one, so there is nothing for the pane to sort on, and the pane says so
where a "Created" column would have been rather than quietly labelling modified time as created.

Do not treat **modified** as a stand-in: a file created three years ago and edited this morning is the
newest thing in the directory by modified time and one of the oldest by creation time. If you specifically
need creation timestamps, get them on the host from a shell tab, using whatever your filesystem records.

Why the pane is not confined to a subtree is explained in
[Security.md](Security.md#the-sftp-file-pane-is-the-same-privilege-in-a-file-browser) — briefly, the same
admin already has a full interactive shell on the same host through the same panel, so a path restriction
would look like a control without being one.

#### What is recorded

**Every session is recorded** in the `audit_logs` table as an open and a close event, with who opened it,
which server, how long it lasted, and how many bytes moved each way. **The commands you type are not
recorded** — the record is that a session happened, not what was done in it. SFTP downloads, uploads and
deletes are recorded individually, as above.

Those five actions — `shell.open`, `shell.close`, `sftp.download`, `sftp.upload`, `sftp.delete` — are the
**only** things in the product that write an audit record. Restarting a service, acting on a Tomcat instance,
deploying a WAR, changing a credential and adding or removing a server or a user all leave **nothing**
behind, and no page in the UI reads the audit table back. See
[Security.md](Security.md#what-does-not-exist).

**On an install without a TLS-terminating reverse proxy, the whole session is plaintext on the network** —
every keystroke, including any password you type at a remote prompt, and every byte of output. That is a
much bigger exposure than a single REST call. See [Security.md](Security.md#the-interactive-shell-is-the-highest-privilege-feature).

## OS Flavour Detection

Discovery reads `/etc/os-release` on the host and records the distribution family, distro id, version,
and package manager. On hosts without it, it falls back to `/etc/redhat-release`,
`/etc/debian_version`, and `lsb_release`.

- Family is one of `rhel`, `debian`, `suse`, `alpine`, or `unknown`. RHEL, CentOS, Rocky, AlmaLinux,
  Fedora, Oracle Linux and Amazon Linux map to `rhel`; Ubuntu, Debian, Mint, Raspbian and Pop!_OS map
  to `debian`; SLES and openSUSE map to `suse`. Anything unrecognized is `unknown` — the server still
  works, you just do not get a family.
- Package manager is whichever of `dnf`, `yum`, `apt`, `zypper`, `apk` is actually present on the
  host, not a guess from the family.

Where the result shows up:

- The inventory table on Server Management has an **OS** column with the distro and version, and the
  family / package manager underneath.
- The server detail **Overview** tab shows `Distribution` and `Package Manager` alongside the raw `OS`
  and `Kernel` strings.

All four values are blank until the server's first successful discovery, so a freshly imported or
credential-less server shows `Unknown`.

## The server detail page

Click a server hostname in the inventory. The URL is `/server/?id=<id>` — the id is the server's
`public_id`.

**Overview**, **Storage**, **Services** and **Log Window** are always present. **Tomcat**, **Containers**
and **Database Logs** appear only when that capability was detected on the host, so a plain web server does
not show three empty tabs. If the selected tab disappears — for instance a re-run of discovery no longer
finds a database — the page falls back to **Overview** rather than leaving an empty panel with no way out.

### What makes a conditional tab appear

Detection comes from the **stored discovery snapshot**, not from a live check when you open the page. Each
condition has a fallback so that software which is installed but not currently logging or running still
gets its tab:

| Tab | Appears when |
| --- | --- |
| **Tomcat** | the Tomcat snapshot has at least one instance, **or** a discovered service's name starts with `tomcat` |
| **Containers** | `docker_version` or `podman_version` is set, **or** a discovered service has type `container` |
| **Database Logs** | `database_logs` has at least one entry, **or** a discovered service has type `database` |

**So a missing tab almost always means "discovery has not seen it", not "the host does not have it."** If
you know a host runs PostgreSQL and there is no Database Logs tab, the fix is to **run discovery** (as an
admin: `Show Admin Tools` → `Operations` → `Discover Services/Storage`) and then reload the page. Servers
imported from CSV have no snapshot at all until you do — they land with status `unknown` and will show none
of the three tabs. A server whose credentials were added after it was created is the same case.

If discovery has run and the tab is still missing, the engine or its log path is outside what discovery
probes — see [Database detection](#database-detection) for exactly what is looked for.

Note also that the **admin tools pane starts collapsed**. It is an occasional tool rather than something
you need on every visit, so click `Show Admin Tools` to reach credentials, discovery and the operations
controls. It is not missing.

A typical session on a newly added host:

1. Admin stores credentials and runs discovery (`Show Admin Tools` → `Operations` →
   `Discover Services/Storage`).
2. Open the `Storage` tab to inspect disk/mount usage as a bar chart plus table.
3. Open the `Services` tab to inspect Docker, Podman, databases, web servers, and app runtimes. Click
   `Logs` on a systemd row for its journal, or `Restart` as an admin.
4. Open the `Tomcat` tab for Tomcat instances, their log files, and restart controls.
5. Open the `Containers` tab, select Docker or Podman, and click `Load`.
6. Click `View` next to a container to read its logs.
7. Open the `Database Logs` tab to view discovered database log files.

Log output from every tab lands in the shared **Log Window** tab.

All of this runs through the backend using the encrypted stored credentials, issuing commands such as
`docker ps`, `podman ps`, `docker logs`, `podman logs`, `df`, `systemctl`, `journalctl`, and `tail` on
discovered database log files. Developer and support users never see or need the credentials.

Nothing here is polled. Each tab reflects the moment you loaded it; press its load/refresh control to
go back to the host. Discovery results are stored on the server record, so the Overview, Storage,
Services, Database Logs and Tomcat tabs can render the last snapshot without a new SSH round trip.

## Storage

The `Storage` tab shows a horizontal bar chart, one bar per mounted filesystem, sorted by usage
descending. Each bar is labelled with its mount point, device, filesystem type, human-readable
used / total, free space, and the used percentage — the numbers are on the chart, not only in the
table. Colour follows the row's health status: accent for healthy, amber for warning, red for
critical, falling back to 80%/90% thresholds when the discovered row has no status. The chart is
readable in both light and dark themes, and every bar also carries a text label, so colour is never
the only signal.

The `df` table is still there, below the chart. Its size, used and available columns are shown in
**GB**, not raw 1K blocks — `df` reports 1K blocks and the UI converts them, so a 50 GB mount reads
`50 GB` rather than `52428800`.

Pseudo-filesystems (`tmpfs`, `devtmpfs`, `squashfs`, `overlay`, `proc`, `sysfs`) and zero-size mounts
are left out of the chart. Servers discovered before this feature landed still chart correctly — the
percentages are derived from the older stored fields when the newer ones are absent.

## Database detection

Discovery looks for databases two ways, and they are independent:

1. **Is it installed or running?** — by systemd unit and by executable on `PATH`. This is what fills the
   `Services` tab and what makes the **Database Logs** tab appear.
2. **Where does it log?** — by testing a fixed list of well-known log paths. This is what fills the
   Database Logs table with something you can actually click.

A host can satisfy the first and not the second: the engine shows up under `Services`, the Database Logs
tab exists, and the table is empty because the log file is not where discovery looked.

**Unit names are matched as patterns, not fixed strings**, which is what makes versioned units work.
Distributions name the same engine differently — `postgresql@16-main` on Debian, `postgresql-16` on RHEL,
`mysqld` versus `mysql` — so discovery resolves the pattern to the real unit names on the host and then
queries each one. Patterns probed: `postgresql*`, `mysql*`, `mysqld*`, `mariadb*`, `mongod*`, `redis*`,
`valkey*`, `mssql-server*`, `oracle*`, `clickhouse-server*`, `cassandra*`, `influxd*`, `couchdb*`,
`elasticsearch*` (alongside the non-database `docker`, `podman`, `rabbitmq-server*`, `kafka*`, `nginx`,
`apache2`, `httpd`, `haproxy`). Up to six matching units per pattern are reported.

Client and server **binaries** are checked too, so an engine reachable from the host but not run by it is
still visible: `psql`, `postgres`, `mysql`, `mysqld`, `mariadb`, `mongod`, `mongosh`, `redis-server`,
`redis-cli`, `valkey-server`, `sqlcmd`, `clickhouse-client`, `cqlsh`, `influx`, `couchdb`, `sqlplus`,
`db2`.

### Log paths that are probed

| Engine | Paths |
| --- | --- |
| PostgreSQL | `/var/log/postgresql/*.log`, `/var/lib/pgsql/data/log/*.log`, `/var/lib/pgsql/*/data/log/*.log`, `/var/lib/pgsql/data/pg_log/*.log` |
| MySQL | `/var/log/mysql/error.log`, `/var/log/mysqld.log`, `/var/log/mysql/*.err` |
| MariaDB | `/var/log/mariadb/*.log` |
| MongoDB | `/var/log/mongodb/*.log` |
| Redis | `/var/log/redis/*.log` |
| Valkey | `/var/log/valkey/*.log` |
| SQL Server | `/var/opt/mssql/log/errorlog` |
| Oracle | `/opt/oracle/diag/rdbms/*/*/trace/alert_*.log`, `/u01/app/oracle/diag/rdbms/*/*/trace/alert_*.log` |
| ClickHouse | `/var/log/clickhouse-server/clickhouse-server.log` |
| Cassandra | `/var/log/cassandra/system.log` |
| InfluxDB | `/var/log/influxdb/*.log` |
| CouchDB | `/var/log/couchdb/*.log` |
| Elasticsearch | `/var/log/elasticsearch/*.log` |
| Db2 | `/home/db2inst1/sqllib/db2dump/db2diag.log` |

### Where this list falls short

Be aware of the coverage, especially for the two enterprise engines:

- **Oracle covers only the two common default layouts.** Discovery guesses `ORACLE_BASE` as `/opt/oracle`
  or `/u01/app/oracle` and looks for the alert log under the standard `diag/rdbms/<db>/<instance>/trace/`
  tree. It does **not** read `ORACLE_BASE`, `ORACLE_HOME` or `$ORACLE_SID` from the environment, consult
  `/etc/oratab`, or ask the database. An installation anywhere else — and a custom `DIAGNOSTIC_DEST` is
  common — will not be found.
- **Db2 covers only the default instance owner.** The single path assumes the instance is `db2inst1` with
  its diagnostic directory in the default place. A second instance, a differently named instance owner, or
  a relocated `DIAGPATH` will not be found.
- **The paths are literal, globbed by the shell.** Anything under a non-standard prefix, a container's
  internal filesystem, or a symlinked log directory the glob does not traverse is invisible.
- **Readability matters.** Discovery only reports a path it can `ls`. A log directory the SSH user cannot
  read looks identical to one that does not exist.

None of this blocks you: the log-path list only drives *convenience*. You can always read a log through the
`Services` tab by journal unit, and the Database Logs tab is populated from discovery rather than typed by
hand — the allowlist that protects the log endpoints is exactly this discovered set, so a path discovery
never found cannot be requested through the API either
([Security.md](Security.md#remote-file-read-is-allowlisted)).

## Tomcat

The server detail page has a `Tomcat` tab. Click `Load / Refresh` to probe the host over SSH; the
result is also saved on the server record, so returning to the tab later renders the last snapshot
without a new SSH round trip. The label next to the button tells you which you are looking at
(`Live probe` or `From discovery on ...`).

Both systemd-managed units and bare Tomcat processes are found. For each instance the table shows
name, Tomcat version, status, whether the unit is enabled, PID, listening ports, and `CATALINA_BASE`.

### Version and environment detail

Expanding an instance row shows what it is actually running, which is more than the table's `version`
column:

- **`Server number`** — the precise build, e.g. `10.1.55.0`. `version` alone can be blank or imprecise.
- **`JVM version` / `JVM vendor`** — the JVM this instance is running on, e.g. `17.0.9+9` /
  `Eclipse Adoptium`.
- **`JAVA_HOME`** — resolved **for this instance**, not the host default. Two Tomcats on one machine can
  be on different JVMs, so a host-wide `java -version` can mislead you.
- **`OS name`** — the host OS as Tomcat reports it.
- **`Configured log dir` / `Primary log file`** — see [below](#which-log-file-to-read).

### Prerequisites

Each instance has a **Prerequisites** block: the name of the requirement, what is **required**, what was
**detected**, and a status chip.

| Chip | Meaning |
| --- | --- |
| `ok` (accent) | detected satisfies required |
| `unsupported` (red) | something is installed, but **below** the requirement |
| `missing` (red) | not found at all |
| `unknown` (slate) | could not determine — usually the Tomcat version could not be read |

A `java` entry is always present, with the minimum derived from the Tomcat version (Tomcat 10.1 needs
Java 11+, 11.0 needs 17+, and so on). Other cheaply-detectable items appear alongside it, such as whether
`JAVA_HOME` is set and whether the webapps directory is writable by the Tomcat user.

**This is the "what does Tomcat need, and what is actually installed" view.** Check it before deploying
anything: an `unsupported` Java is the most common reason a WAR deploys cleanly and then will not start,
and seeing it here costs a glance instead of a stack trace.

### Webapps

A **Webapps** list per instance shows what is under `<catalina_base>/webapps`: name, type (`war` or
`dir`), size and last-modified. Seeing both `myapp.war` and `myapp/` is normal — Tomcat unpacks the WAR
into the directory.

### Per-instance logs

Click `Logs` on an instance row to expand its discovered log files (`catalina.out`, `localhost.*.log`,
access logs, and so on) with size and last-modified time. Pick a file to tail it into the
`Log Window`; the `tail` selector chooses 100/200/500/1000 lines. Any user with access to the server
can read Tomcat logs — no SSH password needed on their side.

Only paths that discovery actually found are readable. If you request anything else the backend
rejects it with `Log path is not a discovered log source for this server. Run discovery first.` If a log
file is new, re-run discovery.

#### Which log file to read

The instance detail names a **`Primary log file`**, and it is usually the one you want. The reason there
is a choice at all is that **two independent mechanisms produce Tomcat logs**:

- **`catalina.out`** is not configured in `logging.properties` at all. It is the shell redirect in
  `catalina.sh`, or the systemd unit's `StandardOutput`, capturing the JVM's stdout and stderr — so it
  gets stack traces thrown before logging initialises, `System.out.println`, and JVM crash output.
  **Read this for a crash or a startup failure.** `Primary log file` prefers it when it exists.
- **The `catalina.<date>.log` family** comes from `conf/logging.properties`, which is why it is
  date-rotated and why it only contains what went through Tomcat's own logging. `Configured log dir` and
  the handler prefix tell you where these land — which is not always `<catalina_base>/logs`.

The two do not agree and neither is a subset of the other. If there is no `catalina.out`, the primary
falls back to the newest file matching the configured prefix; a missing `catalina.out` usually means a
systemd unit sending stdout to the journal instead, which you read from the **Services** tab.

### Restart, start, stop

Admins get `Restart`, `Start` and `Stop` buttons on each instance row. These need root on the remote
host, so one of three things happens:

1. The SSH user is root, or has passwordless sudo — the action runs immediately.
2. Sudo needs a password. The page shows a **Sudo password required** prompt naming the instance and
   the action. Type the sudo password and click `Authenticate and retry`; the action then runs.
3. The sudo password is wrong — you get `Sudo authentication failed` and can retry.

The sudo password is sent once with that single request, delivered to the host over SSH stdin, and
then discarded. It is never stored in the browser, never saved in the database, never written to a
log, and never put on a command line where `ps` could show it. You will be asked again next time.

Tomcat actions are admin-only. Developer and support users can view instances, prerequisites, webapps and
logs, but see no action buttons and no deploy panel.

### Deploy a WAR

Admins get a **Deploy WAR** panel on the Tomcat tab: an instance selector, a file input accepting `.war`,
an optional target filename, and a **restart after deploy** checkbox.

The short version:

1. `Load / Refresh` first. The target directory comes from the **discovered** instance's
   `catalina_base`, so a stale snapshot means the wrong instance.
2. Glance at **Prerequisites**. An `unsupported` Java will not block the upload but will stop the app
   starting.
3. Pick the instance and the file. If the filename already exists in **Webapps**, the panel asks you to
   confirm and states that the existing file will be backed up to `<name>.bak-<timestamp>`.
4. Deploy. The panel shows a busy state — a large WAR over a slow link takes a while, so leave it alone
   rather than retrying.
5. If sudo is needed, the same inline sudo prompt appears; enter the password and retry.

One case to recognise: if the **deploy succeeds but the restart needs a sudo password**, the panel retries
**only the restart** — the WAR is already in place and re-uploading would create a second backup whose
contents are the WAR you just deployed, destroying your rollback point.

The cap is 512 MB by default (`MAX_WAR_MB`). Rollback is a rename on the host using the `.bak-<timestamp>`
file, and there is no rollback button.

**The full procedure, the ownership trap, the stale-unpacked-directory trap and the rollback commands are
in [TomcatDeployment.md](TomcatDeployment.md). Read it before your first deploy.**

## Who can do what

- **admin** — everything: add/import/delete servers, save credentials, run discovery, restart
  services and Tomcat instances, **deploy WARs**, **open an interactive shell**, **browse, download, upload
  and delete files over SFTP**, manage users, policies and dropdown options.
- **developer** — view every tab, read logs, refresh vitals, and **restart containers**. No credentials,
  no discovery, no service or Tomcat actions, no WAR deployment, **no shell and no file pane**.
- **support** — view every tab, read logs and refresh vitals. No actions.

Non-admins additionally only see servers granted to them, directly or through an access policy.

**Almost nothing an operator does is recorded.** Five actions are:

- **Shell sessions** — an open and a close event per session, with the actor, the server, why the session
  ended, the duration and the byte counts, but **not the commands run inside it**.
- **SFTP transfers** — one row per download and per upload, with the remote path and the byte count.
- **SFTP deletes** — one row per successful delete, with the path, whether it was recursive, and how many
  entries were removed. Not the names of those entries.

Browsing a directory is not recorded, and neither is a delete that was refused.

Everything else leaves **no record at all**: WAR deployments, service and Tomcat restarts, credential
changes, adding or deleting servers, user and policy changes, and log reads — **a longer list than the
recorded one.** Five audited actions do not make this an audited product. There is also no page or endpoint
for reading the recorded events back; they have to be queried from the database. See
[Security.md](Security.md#what-does-not-exist).

## Monitoring, and which profile you are on

Everything above works identically in both install profiles. What differs is only the monitoring panel
on the dashboard:

- **Lite** — there is no Grafana, Prometheus, Loki, Promtail or Alertmanager, and no `/metrics`
  endpoint. Logs are read on demand over SSH from the tabs above rather than shipped to a log store, and
  there is no alerting. `GET /api/integrations` returns an empty list, so the dashboard's monitoring panel
  hides itself. If you run one of those tools yourself, point `PROMETHEUS_URL`, `GRAFANA_URL`, `LOKI_URL`
  or `ALERTMANAGER_URL` at it and the panel appears.
- **Full** — all four URLs are set, so the panel shows each service's reachability, and Grafana on port
  13000 has dashboards for the app's request metrics and its container logs. `GET /api/alerts/recent`
  shows recently received alerts, with the caveat that **that list is in memory and empties on every
  restart of the app container** — it is not an alert history. See [Monitoring.md](Monitoring.md).

Not sure which you are on? `docker compose ps` — one container is lite, seven is full.
