# CSV Server Import

Bulk-onboard servers from a CSV file, credentials included. Admin role only.

- UI: **Server Management → Import from CSV**. Paste or upload the CSV, run a dry run, then import.
- API: `POST /api/servers/import` (admin), body `{"csv_text": "...", "dry_run": false}`.

## Security warning: the file contains plaintext credentials

The `password` and `private_key` columns hold usable SSH secrets in clear text. Treat the CSV as a
credential file, not a spreadsheet:

- **Delete it as soon as the import succeeds.** There is no reason to keep it.
- **Never commit it to git**, and never leave it in a repository working tree. Add the filename to
  `.gitignore` before you create it if you must stage it inside a checkout.
- **Never email it, paste it into chat, or attach it to a ticket.** Hand it over out-of-band or, better,
  import from a machine that already holds the credentials.
- Keep it readable only by you (`chmod 600`) while it exists, and prefer a directory that is not
  synced to cloud storage.
- Infra Monitor stores what it reads Fernet-encrypted in the SQLite database. The import response never echoes
  a password or a private key back, so the CSV on disk is the only plaintext copy — which is exactly
  why it has to go.
- The encryption key is derived from `JWT_SECRET`. Anyone who can read both `.env` and the database
  file can recover these credentials, and changing `JWT_SECRET` later makes them permanently
  undecryptable — you would have to import them again. See [BackupRecovery.md](BackupRecovery.md).

## Columns

Header row is required. Column matching is **case-insensitive** and **order-independent**; spaces and
hyphens are treated as underscores, so `IP Address`, `ip-address` and `ip_address` are the same column.
Unknown columns are ignored, so you can keep extra bookkeeping columns in the file. A UTF-8 byte-order
mark is tolerated, so a CSV saved from Excel works.

| Column | Required | Default | Notes |
|---|---|---|---|
| `hostname` | yes | — | Empty value → row `failed`. |
| `ip_address` | yes | — | Empty value → row `failed`. |
| `username` | yes | — | SSH login user. Empty value → row `failed`. |
| `password` | no | `""` | SSH password, stored encrypted. |
| `private_key` | no | `""` | PEM private key, stored encrypted. See the `\n` convention below. |
| `ssh_port` | no | `22` | Non-numeric, or outside 1–65535 → row `failed`. |
| `environment` | no | `production` | |
| `server_type` | no | `application` | e.g. `application`, `database`, `web server`, `tools`. |
| `alias` | no | `""` | Friendly display name. |
| `tags` | no | *(none)* | **Semicolon**-separated. See below. |
| `business_owner` | no | `""` | |
| `support_contact` | no | `""` | |

Full header line:

```
hostname,ip_address,username,password,private_key,ssh_port,environment,server_type,alias,tags,business_owner,support_contact
```

Supply `password`, `private_key`, both, or neither. A row with no credentials is still imported — it
just becomes an inventory-only record until an admin saves credentials on the server detail page.

### Whole-file errors vs per-row errors

Some problems reject the entire request with a 400 and write nothing at all — no partial import:

- the CSV is empty;
- the header row is missing one of `hostname`, `ip_address`, `username` (the message names which);
- the file cannot be parsed, usually an unclosed quoted field;
- there are more than **1000 data rows** — split the file;
- the database write fails, in which case the whole batch is rolled back
  (`"Import could not be saved. No servers were created."`).

Note the distinction on the three required columns: a missing *column* kills the whole request, while a
present column with an *empty value* on some line only fails that row. Everything else — bad
`ssh_port`, a duplicate, an empty required value — is reported per row and does not stop the rest of
the file.

### `tags` uses semicolons

The comma is the CSV field delimiter, so tags are separated by `;`:

```
web;prod;java
```

That becomes three tags: `web`, `prod`, `java`. Writing `web,prod` would instead shift every later
column by one and almost certainly fail the row. Tags are de-duplicated and stored in alphabetical
order, and any stray comma inside a single tag is stripped out.

### `private_key` uses `\n` escapes

A PEM key is multi-line, which a single CSV field cannot hold conveniently. Write the key on one line
with literal backslash-n sequences where the newlines belong; the importer converts them to real
newlines before encrypting:

```
-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkt...\n-----END OPENSSH PRIVATE KEY-----\n
```

If the field contains a comma or a quote, quote the whole field per normal CSV rules (`"..."`, with
`""` for an embedded double quote). Keep the trailing `\n` — most SSH key parsers want the final
newline. A literal `\r\n` sequence is also accepted and collapses to a single newline, so a key
copied from a Windows editor still works.

## Duplicate handling

A row is **skipped**, not failed, when it collides with something that already exists:

- its `hostname` already exists in the inventory, or
- its `ip_address` already exists in the inventory, or
- an earlier row **in the same file** already used that `hostname` or `ip_address` — the first
  occurrence wins and every later duplicate is skipped.

Matching is case-insensitive on both hostname and IP. The row message is
`"Hostname or IP address already exists"`.

Skipped rows change nothing. Re-running the same CSV after a partial import is therefore safe: the
rows that landed the first time come back as `skipped`.

## Dry run

`dry_run=true` validates the whole file and **writes nothing**. Every row comes back as either
`valid` or `failed` (or `skipped`, for duplicates), so you can fix a malformed file before any record
is created.

In the UI the dry run is not optional: the panel has a **1. Dry run** button and a **2. Import
servers** button, and the second stays disabled until the dry run reports at least one valid row. If
you then edit the CSV, import locks again until you re-run the dry run against the new text.

Row statuses:

| Status | Meaning |
|---|---|
| `valid` | Dry run only: the row would import cleanly. |
| `created` | Real import: the server record was created. |
| `skipped` | Duplicate hostname or IP, in the database or earlier in the file. Nothing written. Appears in dry runs too. |
| `failed` | Validation error — an empty required value, a bad `ssh_port`, and so on. Nothing written. |

The result also carries `total`, `created`, `skipped`, `failed` counts and the `dry_run` flag. In a dry
run, `created` is the number of rows that **would** be created — nothing has been written.

The response never contains a password or a private key value.

## Import does NOT run SSH discovery

This is deliberate. Discovering a host takes roughly 20 seconds of SSH round trips; doing that for N
rows inside one HTTP request would blow the request timeout and starve the server's thread pool.

Consequences you need to plan for:

- Every imported server lands with **`status = unknown`** and a health score of 0.
- OS flavour, kernel, CPU/RAM/disk, Docker/Podman, services, Tomcat instances, database log paths and
  storage are all **empty** until discovery runs.
- Log viewing and container listing will not work on an imported server until discovery has populated
  its known log sources.

**Run discovery per server after importing:** open the server from the inventory table — its detail
page is `/server/?id=<public_id>` — then `Show Admin Tools` → `Operations` →
`Discover Services/Storage` (or call `POST /api/servers/{id}/discover`). The import result message
says the same thing.

## Worked example

`servers.csv`:

```csv
hostname,ip_address,username,password,ssh_port,environment,server_type,alias,tags,business_owner,support_contact
app-01,192.168.1.20,ems,S3cret!,22,production,application,Order API node 1,web;prod;java,Payments,ops@example.com
app-02,192.168.1.21,ems,S3cret!,22,production,application,Order API node 2,web;prod;java,Payments,ops@example.com
db-01,192.168.1.30,ems,,22,production,database,Primary Postgres,database;postgresql,Payments,dba@example.com
tools-01,192.168.1.40,ops,,2222,development,tools,Build box,ci,Platform,ops@example.com
```

Note that `db-01` and `tools-01` have an empty `password` field — they import as inventory-only
records. `tools-01` also shows a non-default `ssh_port`.

With a private key instead of a password:

```csv
hostname,ip_address,username,private_key,tags
app-03,192.168.1.22,ems,"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkt...\n-----END OPENSSH PRIVATE KEY-----\n",web;prod
```

Only the columns you need have to be present — the header above omits `password`, `ssh_port`,
`environment`, `server_type`, `alias`, `business_owner` and `support_contact`, so those take their
defaults.

## Checklist

1. Build the CSV; use `;` inside `tags` and `\n` inside `private_key`.
2. Sign in as an admin, open **Server Management → Import from CSV**.
3. Run a **dry run**; fix every `failed` row.
4. Import for real; note the `created` / `skipped` / `failed` counts.
5. **Delete the CSV file.**
6. Run discovery on each new server so it stops reporting `unknown`.
