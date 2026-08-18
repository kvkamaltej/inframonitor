# Kubernetes module

The **Kubernetes** tab lets you register clusters and inspect them live — nodes, pods and logs,
workloads, control-plane health, and events — from inside Infra Monitor, reusing the app's auth, RBAC,
theme, and sidebar.

You **register a cluster once** (the connection is stored); everything else — nodes, pods, logs, health
— is read **live** from the cluster's API server on demand and never stored. This mirrors how managed
clusters (EKS/GKE/AKS) work, where you cannot SSH to the control plane.

## Adding a cluster

Sidebar → **Kubernetes** → **Add cluster**. Two auth methods:

- **Paste a kubeconfig** — easiest for a quick start.
- **ServiceAccount token + API server URL + CA certificate** — the locked-down path; create a read-only
  (or `edit`, for actions) ServiceAccount and a token. The add form has a **"How do I get a token?"**
  helper with the exact `kubectl` commands.

Credentials are **encrypted at rest** (Fernet). Note: kubeconfigs that use **exec auth plugins**
(`aws eks get-token`, `gke-gcloud-auth-plugin`) only work if that CLI is present — a static SA token
avoids this, and is required for the bundled desktop app.

## What you can see and do

- **Overview** — cluster version, node/pod/namespace counts, capacity, and recent Warning events.
- **Nodes** — status, roles, kubelet version, capacity; a node that matches an inventory server (by IP
  or hostname) gets a **Shell** button that opens the web-shell on that server.
- **Pods** — filter by namespace; view **logs** (container / tail / previous), with auto-refresh
  (Off / 5 / 10 / 30 / 60 s) and download.
- **Workloads** — deployments (ready/replicas), with scale and rollout-restart.
- **Health** — `livez` / `readyz` probes, ComponentStatuses, and the kube-system control-plane + addon
  pods (apiserver/etcd/scheduler/controller-manager, CoreDNS, kube-proxy, metrics-server).
- **Events** — recent cluster events.

## Permissions

Viewing (and cluster CRUD) is available to signed-in users — and, in the desktop app, the loopback guest
(see [Security.md](Security.md)). **Actions that change the cluster are admin-only** and blocked for the
guest: restart/delete pod, scale/rollout-restart deployment, cordon/uncordon node. (Node cordon may need
cluster permissions beyond the `edit` role.)

## API (under `/api`)

`GET/POST/PATCH/DELETE /kube/clusters`, `POST /kube/clusters/test`, and per-cluster
`.../{id}/{overview|nodes|namespaces|pods|deployments|health|events}`,
`.../{id}/pods/{ns}/{pod}/logs`, plus admin actions `.../{id}/pods/{ns}/{pod}/restart|DELETE`,
`.../{id}/deployments/{ns}/{name}/scale|restart`, `.../{id}/nodes/{name}/cordon`.

> **Status:** the live-read handlers are unit-tested with a mocked client but have not been verified
> against a real cluster.
