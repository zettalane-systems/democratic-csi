# zettalane-csi

Helm chart for the **ZettaLane CSI driver** — Kubernetes persistent storage on
the MayaNAS / MayaScale storage family, driven over `mayacli` (ONC/RPC, no SSH).

One driver image serves all products; the product is selected per release via
`driver.config.driver` (`mayanas` | `mayascale` | `mayanas-lustre`).

## Install

```sh
helm upgrade --install csi-mayascale \
  oci://<registry>/zettalane/zettalane-csi --version <X.Y.Z> \
  -n zettalane-csi --create-namespace \
  -f examples/mayascale.yaml
```

See `examples/mayascale.yaml` (block / NVMe-oF) and `examples/mayanas.yaml`
(NFS). Fill in the pool, the control-plane VIPs, and the image registry/tag.

## Images & air-gapped / internal-registry clusters

Every `image.registry` value is overridable, so for a private or air-gapped
cluster you mirror the images into your own registry (e.g. Artifact Registry)
and point the chart at them:

- **driver** — `controller.driver.image` / `node.driver.image` (the
  `zettalane-csi` image).
- **CSI sidecars** — `registry.k8s.io/sig-storage/*` (provisioner, resizer,
  snapshotter, node-driver-registrar) — standard, mirrorable Kubernetes images.

## Managed Kubernetes (GKE, and likely EKS/AKS)

On a managed cluster a few overrides are needed vs a vanilla/k3s install (the
examples default to the latter). Validated on GKE — csi-sanity 40/42, same as k3s.

- **`controller.hostNetwork: true`** — managed CNIs don't SNAT pod→node for the
  RFC1918 storage VIPs, so the controller must use the node netns to reach the
  control plane; otherwise volume provisioning times out. (The node DaemonSet is
  already hostNetwork.)
- **Clear the priority classes** — `controller.priorityClassName: ""` and
  `node.priorityClassName: ""`. GKE's resource quota rejects `system-*-critical`
  priority outside `kube-system`, so the pods won't schedule otherwise.
- **Block / NVMe-oF data path** — use an **Ubuntu node pool** (GKE COS lacks
  `nvme_tcp`) so node-stage `nvme connect` works. NFS-only deployments don't need it.
- **Snapshots** — managed clusters ship the VolumeSnapshot CRDs, so you can set
  `controller.externalSnapshotter.enabled: true`.
- **Image** — mirror the driver image into a registry the cluster can pull; on
  GKE, nodes in the same project auto-authenticate to Artifact Registry.
- The cluster must have network reachability to the storage control-plane VIPs
  (same VPC / peered).

## Notes

- Runs as **root** (mayacli requires it).
- NFS is mount-only (`csiDriver.attachRequired: false`); block uses NVMe-oF.
- `fullnameOverride` (set in the examples to `csi-mayascale` / `csi-mayanas`)
  selects the rendered workload names.
- `csiProxy` is disabled by default — the driver serves its CSI socket directly.
</content>
