# Prometheus file-based service discovery

This directory is bind-mounted read-only into the Prometheus container at
`/etc/prometheus/targets`, and the `node-exporters` job in `../prometheus.yml`
reads `*.json` from it every 30 seconds.

It ships with `node-exporters.json` containing an empty list, so the job starts
with zero targets deliberately.

> The reason this directory exists at all: the previous configuration had the
> same `file_sd_configs` job pointing at this path **without mounting it**. The
> job could never have had a single target, yet the config read as though node
> monitoring were set up. Either mount the directory or drop the job — this is
> the "mount it" option, because scraping node_exporters on managed servers is a
> thing an operator plausibly wants and this makes it a one-file edit.

## Adding targets

There is no `node_exporter` container in this stack. These entries are for
`node_exporter` processes you run yourself on the machines in your inventory
(default port 9100). Edit `node-exporters.json`:

```json
[
  {
    "targets": ["app-server-01.example.com:9100", "db-server-02.example.com:9100"],
    "labels": { "env": "prod", "role": "app" }
  },
  {
    "targets": ["staging-01.example.com:9100"],
    "labels": { "env": "staging" }
  }
]
```

No restart is needed — Prometheus re-reads the file. Confirm at
`http://127.0.0.1:19090/targets` that the `node-exporters` job lists what you
expect. Any file matching `*.json` in this directory is read, so you can split
targets across several files.

Note that the `PrometheusTargetDown` alert covers every target in every job,
including these, so an unreachable node_exporter will alert once it has been
down for 3 minutes.
