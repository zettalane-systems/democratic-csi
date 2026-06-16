//
// Copyright (c) 2026 ZettaLane Systems LLC. All rights reserved.
//
const _ = require("lodash");
const { GrpcError, grpc } = require("../../utils/grpc");
const { CsiBaseDriver } = require("../index");
const { Mayacli, VOL_TYPE, ERRNO } = require("../../utils/mayacli");

// mayacli exits with an errno (e.code); map the surfacing ones to CSI codes.
const ERRNO_TO_GRPC = {
  [ERRNO.EPERM]: grpc.status.PERMISSION_DENIED,
  [ERRNO.ENOENT]: grpc.status.NOT_FOUND,
  [ERRNO.EBUSY]: grpc.status.FAILED_PRECONDITION,
  [ERRNO.EEXIST]: grpc.status.ALREADY_EXISTS,
  [ERRNO.EINVAL]: grpc.status.INVALID_ARGUMENT,
  [ERRNO.EOPNOTSUPP]: grpc.status.FAILED_PRECONDITION,
  28: grpc.status.RESOURCE_EXHAUSTED, // ENOSPC
  13: grpc.status.PERMISSION_DENIED, // EACCES
};

/**
 * controller-zettalane — CSI driver for ZettaLane products over `mayacli`
 * (ONC/RPC, no SSH). ONE class, product selected by `options.driver` (factory.js):
 *   - mayanas        : ZFS; protocol = nfs|smb|iscsi|nvmeof
 *   - mayascale      : md/RAID block; protocol = iscsi|nvmeof
 *   - mayanas-lustre : client mount of the auto-managed `zettafs`
 * Design + mayacli wire format: builder/mayastor/docs/CSI_DRIVER_DESIGN.md.
 */
class ControllerZettalaneDriver extends CsiBaseDriver {
  constructor(ctx, options) {
    super(...arguments);

    options = options || {};
    options.service = options.service || {};
    options.service.identity = options.service.identity || {};
    options.service.controller = options.service.controller || {};
    options.service.node = options.service.node || {};

    options.service.identity.capabilities =
      options.service.identity.capabilities || {};
    options.service.controller.capabilities =
      options.service.controller.capabilities || {};
    options.service.node.capabilities =
      options.service.node.capabilities || {};

    // GetPluginCapabilities reads identity.capabilities.service + .volume_expansion (not .rpc)
    if (!("service" in options.service.identity.capabilities)) {
      options.service.identity.capabilities.service = [
        "CONTROLLER_SERVICE",
        // "VOLUME_ACCESSIBILITY_CONSTRAINTS",  // enable with the zone_cluster_map port
      ];
    }
    if (!("volume_expansion" in options.service.identity.capabilities)) {
      options.service.identity.capabilities.volume_expansion = ["ONLINE"];
    }

    if (!("rpc" in options.service.controller.capabilities)) {
      options.service.controller.capabilities.rpc = [
        "CREATE_DELETE_VOLUME",
        "LIST_VOLUMES",
        "GET_CAPACITY", // pool free via `-j show zpool` (root dataset `cle`)
        "CREATE_DELETE_SNAPSHOT",
        "LIST_SNAPSHOTS",
        "CLONE_VOLUME", // copy snapshot <vol>@<snap> <newlabel> (zfs clone)
        "EXPAND_VOLUME", // fs -> zfs set refquota (configd); zvol -> zfs set volsize
        "GET_VOLUME",
        "SINGLE_NODE_MULTI_WRITER",
      ];
    }

    if (!("rpc" in options.service.node.capabilities)) {
      const nodeCaps = [
        "STAGE_UNSTAGE_VOLUME",
        "GET_VOLUME_STATS",
        "SINGLE_NODE_MULTI_WRITER",
      ];
      // block (zvol) needs node-side resize; a filesystem share grows server-side (no node EXPAND)
      if (this.getDriverZfsResourceType() === "volume") {
        nodeCaps.push("EXPAND_VOLUME");
      }
      options.service.node.capabilities.rpc = nodeCaps;
    }

    // wrap every controller RPC: a mayacli errno (or any throw) -> CSI status via toGrpcError
    for (const m of [
      "CreateVolume", "DeleteVolume", "ControllerExpandVolume",
      "CreateSnapshot", "DeleteSnapshot", "ListSnapshots", "ListVolumes",
      "ControllerGetVolume", "GetCapacity", "ValidateVolumeCapabilities",
    ]) {
      const orig = this[m].bind(this);
      this[m] = async (call) => {
        try {
          return await orig(call);
        } catch (e) {
          throw this.toGrpcError(e);
        }
      };
    }
  }

  // ---- helpers --------------------------------------------------------------

  /** Control-plane endpoints from the driver-named config key (`mayanas:"vip1,vip2"`). */
  endpoints() {
    const raw = _.get(this.options, this.options.driver);
    return String(raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** mayacli client from driver config; `hosts` overrides the endpoint list. */
  getMayacli(hosts) {
    const o = this.options || {};
    // target a specific pool's owning VIP for control ops
    const eps = hosts && hosts.length ? hosts : this.endpoints();
    if (!eps.length) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: options.${o.driver} (cluster VIP list) is required`
      );
    }
    return new Mayacli({
      host: eps,
      binPath: o.path,
      timeout: o.timeout,
      sudo: o.sudo,
      logger: this.ctx.logger,
    });
  }

  /** Map a mayacli error (e.code = errno) to a CSI GrpcError; pass GrpcErrors through. */
  toGrpcError(e, prefix) {
    if (e instanceof GrpcError) return e;
    const code =
      ERRNO_TO_GRPC[e && e.code] != null ? ERRNO_TO_GRPC[e.code] : grpc.status.INTERNAL;
    const msg = (e && e.message) || String(e);
    return new GrpcError(code, prefix ? `${prefix}: ${msg}` : msg);
  }

  /**
   * Resolve a pool to {clusterid, server(=data VIP), kind}: pinned override
   * (options.pools[pool]) else live discovery (buildPoolView).
   */
  async resolvePool(pool, mayacli) {
    const cfg = _.get(this.options, ["pools", pool]);
    if (cfg && cfg.clusterid != null && cfg.vip) {
      // kind: prefer a live probe (authoritative). Never guess on failure.
      let kind, probed = false;
      try {
        kind = (await (mayacli || this.getMayacli()).getPoolInfo(pool)).kind;
        probed = true;
      } catch (e) {
        // Probe failed -> the kind is genuinely unknown (it could be any of
        // zpool/vg/thinpool). Honor an explicit configured kind if the user asserted
        // one; otherwise reject -- do NOT assume a default like zpool.
        if (!cfg.kind) {
          throw new GrpcError(
            grpc.status.FAILED_PRECONDITION,
            `pool '${pool}': cannot determine pool kind -- ${e.message}`
          );
        }
        kind = cfg.kind;
      }
      // A user-pinned kind that disagrees with the probed pool cannot be honored --
      // reject rather than silently substituting the discovered kind.
      if (probed && cfg.kind && cfg.kind !== kind) {
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `pool '${pool}': requested kind=${cfg.kind} but the pool is '${kind}'`
        );
      }
      return { clusterid: cfg.clusterid, server: cfg.vip, kind };
    }

    const view = await this.buildPoolView();
    const rec = pool
      ? view.find((p) => p.name === pool)
      : view.find((p) => p.default) || (view.length === 1 ? view[0] : null);
    if (!rec) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        pool
          ? `pool '${pool}' not found on any ${this.options.driver} endpoint (${this.endpoints().join(",")})`
          : `no StorageClass 'pool' parameter and no unique default among ${view.length} discovered pool(s)`
      );
    }
    return { clusterid: rec.clusterid, server: rec.vip, kind: rec.kind };
  }

  /**
   * Owning VIP of an existing volume/snapshot. Mutating ops (Delete/Expand/Snapshot) get NO
   * pool in the CSI request -- unlike CreateVolume, which is handed the StorageClass pool and
   * pins via resolvePool. They must derive the owner from the object itself: its `cid` is on
   * the voldb entry and is returned by ANY node (peer-synced), and byMapid[cid] is the floating
   * owner VIP. Control MUTATIONS must pin here -- an unpinned call lands on the first VIP, finds
   * the entry via the synced voldb (looks valid), and runs the backend op on a VG that node
   * doesn't have. Reads stay node-agnostic. Returns null if the object is gone (caller then
   * proceeds best-effort -- fine for idempotent deletes).
   */
  async ownerServer(probe, id) {
    const v = await probe.showVolume(id); // targeted lookup (the object carries its own cid)
    if (!v) {
      // genuinely gone -> caller proceeds best-effort (idempotent delete / its own NOT_FOUND)
      this.ctx.logger.warn(`ownerServer: '${id}' not found on probe -> null (caller falls back to first VIP)`);
      return null;
    }
    // The object EXISTS, so its owner MUST be resolvable. A mutation must NEVER fall through to an
    // arbitrary (first) VIP -- that silently runs the backend op on a node that lacks the pool and
    // either errors ("No such file or directory") or, worse, mutates the wrong place. Fail loudly.
    const { byMapid } = await probe.showFailover();
    const server = v.cid != null ? byMapid[String(v.cid)] : null;
    if (!server) {
      this.ctx.logger.warn(`ownerServer: '${id}' cid=${v.cid} has no VIP in byMapid=${JSON.stringify(byMapid)}`);
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `cannot locate the owning node for '${id}' (cid=${v.cid}); refusing to route a mutation to an arbitrary node`
      );
    }
    this.ctx.logger.verbose(`ownerServer: '${id}' cid=${v.cid} -> ${server}`);
    return server;
  }

  /**
   * Discover all pools ONCE from a single endpoint (configd is cluster-aware).
   * vip = byMapid[clusterid] from `show failover` is the single source of truth
   * (control + data). Cached; concurrent callers share _poolViewPromise so they
   * cannot cache divergent VIPs. Record {name,clusterid,vip,kind,source,default}.
   */
  async buildPoolView() {
    if (this._poolView) return this._poolView;
    // one discovery, others await it; clear on failure so a partial view is never cached
    if (!this._poolViewPromise) {
      this._poolViewPromise = this._discoverPools().then(
        (pools) => {
          this._poolView = pools;
          this._poolViewPromise = null;
          return pools;
        },
        (e) => {
          this._poolViewPromise = null;
          throw e;
        }
      );
    }
    return this._poolViewPromise;
  }

  async _discoverPools() {
    // only true provisioning pools (zpool/vg/thinpool); NOT V_RG (md backing, never a
    // CSI target) -- see CSI_DRIVER_DESIGN.md
    const POOL_KIND = {
      [VOL_TYPE.ZPOOL]: "zpool",
      [VOL_TYPE.VG]: "vg",
      [VOL_TYPE.THINPOOL]: "thinpool", // LVM thin pool -> `thinpool=<pool>` (thin LVs)
    };
    const mayacli = this.getMayacli(); // full endpoint list -> reachability failover
    const vols = await mayacli.showVolumes(); // every pool (cluster-aware)
    const fo = await mayacli.showFailover(); // authoritative clusterid -> VIP
    const eps = this.endpoints();
    const pools = [];
    for (const v of vols) {
      const kind = POOL_KIND[v.t];
      if (!kind) continue; // not a pool
      const clusterid = Number(v.cid);
      // HA: cid=0 is a peer-sync phantom (no VIP) -> skip. standalone: cid=0 is valid.
      if (!clusterid && eps.length > 1) continue;
      // VIP from the authoritative failover map; single-endpoint fallback only when no HA
      const vip =
        (fo.byMapid && fo.byMapid[String(clusterid)]) ||
        (eps.length === 1 ? eps[0] : null);
      if (!vip) {
        throw new GrpcError(
          grpc.status.UNAVAILABLE,
          `pool '${v.l}' (clusterid ${clusterid}): no failover VIP yet; discovery incomplete`
        );
      }
      pools.push({ name: v.l, clusterid, vip, kind, source: "discovered" });
    }
    const perVip = {};
    for (const p of pools) perVip[p.vip] = (perVip[p.vip] || 0) + 1;
    for (const p of pools) p.default = perVip[p.vip] === 1;
    this.ctx.logger.verbose("discovered pools: %j", pools);
    return pools;
  }

  /**
   * Backing resource type, fixed per driver: NAS (NFS/SMB/Lustre) -> filesystem
   * dataset; block (nvme-of/iscsi) -> zvol. Drives create, mapping type, node EXPAND.
   */
  getDriverZfsResourceType() {
    switch (this.options.driver) {
      case "mayanas":
      case "mayanas-lustre":
        return "filesystem";
      case "mayascale":
        return "volume";
      default:
        throw new Error("unknown driver: " + this.options.driver);
    }
  }

  /** mayacli volume types this driver manages: fs -> V_FILESYS; block -> V_FLEX|V_BLOCK|V_ZVOL. */
  driverVolTypes() {
    return this.getDriverZfsResourceType() === "filesystem"
      ? [VOL_TYPE.FILESYS]
      : [VOL_TYPE.FLEX, VOL_TYPE.BLOCK, VOL_TYPE.ZVOL];
  }

  /** CSI access modes accepted (NAS share = multi-writer; block = single-node). */
  getAccessModes() {
    if (this.getDriverZfsResourceType() === "filesystem") {
      return [
        "UNKNOWN", "SINGLE_NODE_WRITER", "SINGLE_NODE_SINGLE_WRITER",
        "SINGLE_NODE_MULTI_WRITER", "SINGLE_NODE_READER_ONLY",
        "MULTI_NODE_READER_ONLY", "MULTI_NODE_SINGLE_WRITER", "MULTI_NODE_MULTI_WRITER",
      ];
    }
    return [
      "UNKNOWN", "SINGLE_NODE_WRITER", "SINGLE_NODE_SINGLE_WRITER",
      "SINGLE_NODE_MULTI_WRITER", "SINGLE_NODE_READER_ONLY",
      "MULTI_NODE_READER_ONLY", "MULTI_NODE_SINGLE_WRITER",
    ];
  }

  /** Validate requested volume_capabilities for this backend. */
  // Multi-protocol: the fs_type allow-list keys on the attach driver (the node path
  // passes it), not a driver-wide resource type -- block (iscsi/nvmeof) carries an
  // on-disk fs (ext4/xfs), nfs/smb carry the network fs. When absent (controller-side
  // ValidateVolumeCapabilities) accept the union; CreateVolume's PROTO map is the real gate.
  assertCapabilities(capabilities, node_attach_driver) {
    const BLOCK_FS = ["btrfs", "ext3", "ext4", "ext4dev", "xfs"];
    let message = null;
    const modes = this.getAccessModes();
    let fsTypes, isFs;
    switch (node_attach_driver) {
      case "nfs": fsTypes = ["nfs"]; isFs = true; break;
      case "smb": fsTypes = ["cifs"]; isFs = true; break;
      case "lustre": fsTypes = ["lustre"]; isFs = true; break;
      case "iscsi":
      case "nvmeof": fsTypes = BLOCK_FS; isFs = false; break;
      default: fsTypes = ["nfs", "cifs", "lustre", ...BLOCK_FS]; isFs = null;
    }
    const valid = (capabilities || []).every((capability) => {
      // filesystem protocols are mount-only; block may also be raw-block.
      if (isFs === true && capability.access_type && capability.access_type != "mount") {
        message = `invalid access_type ${capability.access_type}`;
        return false;
      }
      if (
        capability.mount &&
        capability.mount.fs_type &&
        !fsTypes.includes(capability.mount.fs_type)
      ) {
        message = `invalid fs_type ${capability.mount.fs_type}`;
        return false;
      }
      if (capability.access_mode && !modes.includes(capability.access_mode.mode)) {
        message = `invalid access_mode ${capability.access_mode.mode}`;
        return false;
      }
      return true;
    });
    return { valid, message };
  }

  getProtocol(call) {
    const driver = this.options.driver;
    if (driver === "mayanas-lustre") return "lustre";
    const p = _.get(call, "request.parameters.protocol", "");
    if (!p) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `StorageClass parameter 'protocol' is required for driver '${driver}'`
      );
    }
    return p.toLowerCase();
  }

  /** Required StorageClass parameter or a clear error. */
  reqParam(call, key) {
    const v = _.get(call, `request.parameters.${key}`);
    if (v === undefined || v === null || v === "") {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `StorageClass parameter '${key}' is required`
      );
    }
    return v;
  }

  /** NFS export options. fsid is owned by configd (client fsid= is stripped). */
  buildNfsOptions(rawOpts) {
    return rawOpts || "*(rw,sync,no_root_squash)";
  }

  capacityFromCall(call) {
    let cr = call.request.capacity_range;
    if (!cr || Object.keys(cr).length === 0) {
      cr = { required_bytes: 1073741824 }; // 1 GiB default
    }
    if (
      cr.required_bytes > 0 &&
      cr.limit_bytes > 0 &&
      cr.required_bytes > cr.limit_bytes
    ) {
      throw new GrpcError(
        grpc.status.OUT_OF_RANGE,
        "required_bytes is greater than limit_bytes"
      );
    }
    const capacity_bytes = cr.required_bytes || cr.limit_bytes;
    if (!capacity_bytes) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        "volume capacity is required (required_bytes or limit_bytes)"
      );
    }
    return capacity_bytes;
  }

  // ---- controller RPCs ------------------------------------------------------

  /** protocol -> {access, mapping controller, node_attach_driver}. nfs/nvme-of ready. */
  static PROTO = {
    nfs: { access: "filesystem", controller: "nfs", attach: "nfs", ready: true },
    // smb: profile via parameters.smbProfile (default posix). Node mounts
    // //server/<volname> with cifs creds from the node-stage secret (mount_flags
    // username=,password=). share = m_share (= volname). See §SMB in CSI_DRIVER_DESIGN.
    smb: { access: "filesystem", controller: "smb", attach: "smb", ready: true },
    // iscsi: per-PVC target (IQN) + portal (TPGT, fixed :3260), LUN 0. Node logs in
    // via iscsiadm to <vip>:3260. Userspace maya.iscsid target (nvme-of is the perf
    // default; iscsi is the compat path).
    iscsi: { access: "block", controller: "iscsi", attach: "iscsi", ready: true },
    "nvme-of": { access: "block", controller: "nvmet-tcp", attach: "nvmeof", ready: true },
    nvmeof: { access: "block", controller: "nvmet-tcp", attach: "nvmeof", ready: true },
  };

  async CreateVolume(call) {
    const driver = this;
    const protocol = this.getProtocol(call);
    const pp = ControllerZettalaneDriver.PROTO[protocol];
    if (!pp || !pp.ready) {
      const ready = Object.keys(ControllerZettalaneDriver.PROTO).filter(
        (k) => ControllerZettalaneDriver.PROTO[k].ready
      );
      throw new GrpcError(
        grpc.status.UNIMPLEMENTED,
        `protocol '${protocol}' not supported (have: ${ready.join(", ")})`
      );
    }

    if (
      !call.request.volume_capabilities ||
      call.request.volume_capabilities.length === 0
    ) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, "missing volume_capabilities");
    }

    const label = await driver.getVolumeIdFromCall(call); // sanitized pvc name
    const pool = this.reqParam(call, "pool");
    // server = the pool's owning VIP: control RPCs target it AND it is volume_context.server
    const { clusterid, server, kind } = await this.resolvePool(pool);
    const mayacli = this.getMayacli([server]);
    const recordsize = _.get(call, "request.parameters.recordsize", "128K");
    // backend filesystem for LVM file pools (vg/thinpool NFS/SMB): xfs (default) | ext4.
    // ignored for zpool (always zfs) and for block volumes.
    const backendFs = String(
      _.get(call, "request.parameters.filesystem", "xfs")
    ).toLowerCase();
    if (!["xfs", "ext4"].includes(backendFs)) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `parameters.filesystem '${backendFs}' unsupported (xfs|ext4)`
      );
    }
    // thick by default; thin is opt-in (zfs drops refreservation, LVM uses a thin pool)
    const thinRaw = _.get(call, "request.parameters.thin"); // undefined if not specified
    const thin = String(thinRaw ?? "").toLowerCase() === "true";
    // Reject thin/kind combinations that cannot be honored -- don't silently override the
    // user's request. A vg is thick-only; a thinpool is thin-only; only zpool serves both.
    // An absent thin follows the kind's default; only an explicit contradicting value fails.
    if (kind === "vg" && thin) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `pool '${pool}' is a thick VG; thin provisioning is not supported (use a thinpool pool)`
      );
    }
    if (kind === "thinpool" && thinRaw !== undefined && !thin) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `pool '${pool}' is a thinpool; thick provisioning (thin:false) is not supported`
      );
    }
    const capacity_bytes = this.capacityFromCall(call);

    // mayacli label: a zpool prefixes <pool>-<label>; a VG uses the bare label.
    const vol = kind === "zpool" ? `${pool}-${label}` : label;
    const content_source = call.request.volume_content_source;

    // exact-fit idempotency: pvcname + capacity + active export must match (partial-failure self-heal)
    let deferExport = false;
    const exists = await mayacli.volumeExists(vol);
    if (exists) {
      // same name + different capacity = ALREADY_EXISTS conflict
      const existing = await this.existingCapacity(vol, mayacli);
      if (existing && Number(existing) !== Number(capacity_bytes)) {
        throw new GrpcError(
          grpc.status.ALREADY_EXISTS,
          `volume '${vol}' already exists with capacity ${existing} (requested ${capacity_bytes})`
        );
      }
    } else {
      // a content-source VOLUME must exist (a missing snapshot surfaces as ENOENT->NOT_FOUND)
      if (
        content_source &&
        content_source.volume &&
        !(await mayacli.volumeExists(content_source.volume.volume_id))
      ) {
        throw new GrpcError(
          grpc.status.NOT_FOUND,
          `source volume '${content_source.volume.volume_id}' not found`
        );
      }
      if (content_source && content_source.snapshot) {
        // clone from snapshot: snapshot_id IS the configd label -> clone it directly
        const sid = content_source.snapshot.snapshot_id;
        const { srcKind } = await mayacli.volSrcInfo(sid);
        // vg clone target is filled by async dd -> defer export to node-stage
        if (srcKind === "vg") deferExport = true;
        await mayacli.createVolumeFromSnapshot({
          label,
          snapshotof: sid,
          vol: srcKind === "vg" ? undefined : vol,
          sizeG: srcKind === "vg" ? undefined : Math.ceil(capacity_bytes / 1024 ** 3),
        });
      } else if (content_source && content_source.volume) {
        // clone from a volume: snapshot the source first, then clone it
        const srcVol = content_source.volume.volume_id;
        const { srcKind, sizeBytes } = await mayacli.volSrcInfo(srcVol);
        const snap = `clonesnap-${label}`;
        const sopts = { name: snap, vol: srcVol };
        if (srcKind === "vg")
          sopts.size = `${Math.max(1, Math.ceil((sizeBytes * 25) / 100 / (1024 * 1024)))}M`;
        await mayacli.createSnapshot(sopts);
        if (srcKind === "vg") deferExport = true;
        await mayacli.createVolumeFromSnapshot({
          label,
          snapshotof: Mayacli.snapName(srcKind, srcVol, snap),
          vol: srcKind === "vg" ? undefined : vol,
          sizeG: srcKind === "vg" ? undefined : Math.ceil(capacity_bytes / 1024 ** 3),
        });
      } else {
        // fresh create: filesystem -> V_FILESYS, block -> V_FLEX (thick unless thin)
        await mayacli.createVolume({
          label,
          container: { kind, name: pool },
          access: pp.access,
          sizeBytes: capacity_bytes,
          recordsize,
          fs: backendFs,
          thin,
          clusterid,
        });
      }
    }

    // ensure the export exists AND is active; idempotent (rebuild only what's missing)
    if (!deferExport) {
     try {
      const maps = await mayacli.showMapping(vol);
      if (!maps.some((m) => m.a)) {
        if (pp.attach === "iscsi") {
          // iscsi: per-PVC target (IQN) + portal (TPGT, fixed :3260), replicated to the
          // peer (get-or-create). Mirrors nvme-of; LUN 0 (not nsid 1), no per-PVC port.
          const iqn = Mayacli.csiIqn(vol);
          const have = (await mayacli.showIscsiTargets()).find((s) => s.iqn === iqn);
          const portal =
            have && have.portalTag != null
              ? { tag: have.portalTag }
              : await mayacli.createIscsiPortalAuto(server, iqn);
          if (!have) await mayacli.createIscsiTarget(iqn, portal.tag);
          const peer = this.endpoints().find((e) => e !== server);
          if (peer) {
            const peerCli = this.getMayacli([peer]);
            await peerCli.createIscsiPortal(portal.tag, server);
            await peerCli.createIscsiTarget(iqn, portal.tag);
          }
          if (!maps.length) {
            await mayacli.createMapping({
              vol,
              controller: pp.controller, // iscsi
              clusterid,
              // targetid = TPGT; lun=0 (iscsi LUNs start at 0, vs nvme nsid 1)
              extra: [`nodename=${iqn}`, "lun=0", `targetid=${portal.tag}`],
            });
          }
        } else if (pp.access !== "filesystem") {
          // nvme-of: per-PVC portal + subsystem + namespace, replicated to the peer (get-or-create)
          const nqn = Mayacli.csiNqn(vol);
          const have = (await mayacli.showSubsystems()).find((s) => s.nqn === nqn);
          const portal =
            have && have.portalTag != null
              ? { tag: have.portalTag, port: have.portalPort }
              : await mayacli.createPortalAuto(server, nqn);
          if (!have) await mayacli.createSubsystem(nqn, portal.tag);
          const peer = this.endpoints().find((e) => e !== server);
          if (peer) {
            const peerCli = this.getMayacli([peer]);
            await peerCli.createPortal(portal.tag, server, portal.port);
            await peerCli.createSubsystem(nqn, portal.tag);
          }
          if (!maps.length) {
            await mayacli.createMapping({
              vol,
              controller: pp.controller, // nvmet-tcp
              clusterid,
              // targetid = portal tag -> per-PVC kernel port-dir (else all reuse port-dir 0)
              extra: [`nodename=${nqn}`, "lun=1", `targetid=${portal.tag}`],
            });
          }
        } else if (!maps.length && protocol === "smb") {
          // smb share: posix profile (no AD -- share dir 2775 root:samba-users,
          // the auto sambadmin is in samba-users) + read_only=No (Samba defaults
          // shares read-only). Node mounts cifs as sambadmin (creds from the
          // node-stage secret mount_flags). windows profile needs AD SIDs+chown.
          const profile = _.get(call, "request.parameters.smbProfile", "posix");
          const smbOpts = _.get(
            call,
            "request.parameters.smbOptions",
            "browseable=Yes;read_only=No"
          );
          await mayacli.createMapping({
            vol,
            controller: pp.controller, // smb
            clusterid,
            extra: [`profile=${profile}`],
            options: smbOpts,
          });
        } else if (!maps.length) {
          // nfs share: NFS export options.
          await mayacli.createMapping({
            vol,
            controller: pp.controller,
            clusterid,
            options: this.buildNfsOptions(_.get(call, "request.parameters.nfsOptions")),
          });
        }
        // bind on the owning VIP (mayacli targets server == byMapid[clusterid]); idempotent.
        await mayacli.bindMapping(vol, clusterid);
      }
      await mayacli.save();
     } catch (e) {
       // CSI_DEBUG_PANIC=1: freeze on first failure (see docs/mayanas/csi-debug-panic.md)
       if (process.env.CSI_DEBUG_PANIC) {
         console.error(`[CSI_PANIC] export/mapping failed vol=${vol} clusterid=${clusterid}: ${e && e.message}`);
         process.exit(42);
       }
       throw e;
     }
    }

    // volume_context per access type
    let volume_context;
    if (pp.access === "filesystem") {
      // share is configd-authoritative -- read it from the bound mapping (m_share):
      // nfs => mountpoint path, smb => share name (volname). Fall back to the
      // volume mountpoint (showVolume.d), then /<pool>/<label>, for pre-m_share configd.
      // m_share is the uniform, protocol-correct source (nfs => path, smb => name).
      // No per-protocol branch: read it straight from the bound mapping.
      const m = (await mayacli.showMapping(vol)).find((x) => x.a) || {};
      let share = m.sh;
      if (!share) {
        // transition only: pre-m_share configd has no share field -> volume
        // mountpoint (nfs-correct; smb requires the m_share-capable configd).
        const v = await mayacli.showVolume(vol);
        share = v && v.d ? v.d : `/${pool}/${label}`;
      }
      volume_context = { node_attach_driver: pp.attach, server, share };
      // NFS export model from the mapping version (m.h): 255=all / 4=v4 -> v4
      // pseudoroot (share is fsid=0-relative); 3 -> standalone pure-v3 export.
      // A v3 CLIENT on a pseudoroot export must prepend the fsid=0 root; the node
      // decides per the requested nfsvers. Standalone (h==3) needs no prefix.
      if (pp.attach === "nfs" && m.h !== undefined && m.h !== 3) {
        volume_context.nfs_pseudoroot = "/export"; // configd fsid=0 root
      }
    } else if (pp.attach === "iscsi") {
      // iscsi: iqn + lun from the bound mapping; portal = owner VIP :3260 (the node
      // iscsiadm-logs-in; VIP failover handles HA, no client multipath needed).
      const m = (await mayacli.showMapping(vol)).find((x) => x.n) || {};
      volume_context = {
        node_attach_driver: "iscsi",
        portal: `${server}:3260`,
        iqn: m.n || Mayacli.csiIqn(vol),
        lun: String(m.l != null ? m.l : 0),
      };
    } else {
      // nvme-of: nqn + nsid from the bound mapping; listener port = the per-PVC portal's port
      const m = (await mayacli.showMapping(vol)).find((x) => x.n) || {};
      const nqn = m.n || Mayacli.csiNqn(vol);
      const sub = (await mayacli.showSubsystems()).find((s) => s.nqn === nqn);
      const port = sub && sub.portalPort ? sub.portalPort : 4420;
      volume_context = {
        node_attach_driver: "nvmeof",
        // transports carries proto+host+port; a bare transport:"tcp" only adds a
        // phantom connection -> node sees >1 path, breaks on kernels w/o native
        // nvme multipath (e.g. AL2023/EKS) via the DM-multipath branch.
        transports: `tcp://${server}:${port}`,
        nqn,
        nsid: String(m.l != null ? m.l : 1),
      };
    }

    let accessible_topology;
    if (typeof this.getAccessibleTopology === "function") {
      accessible_topology = await this.getAccessibleTopology(call);
    }

    return {
      volume: {
        volume_id: vol,
        capacity_bytes: capacity_bytes,
        content_source: content_source,
        volume_context: volume_context,
        accessible_topology: accessible_topology,
      },
    };
  }

  async DeleteVolume(call) {
    const vol = call.request.volume_id;
    if (!vol) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, "volume_id is required");
    }

    const delete_strategy = _.get(
      this.options,
      "_private.csi.volume.deleteStrategy",
      ""
    );
    if (delete_strategy === "retain") {
      return {};
    }

    // Pin every mutation to the volume's OWNER. Unpinned, the call lands on the first VIP and
    // the peer-synced voldb makes it look valid -- but unbind/delete then run on a VG that node
    // doesn't have. (DeleteVolume gets no pool, so derive the owner from the volume's cid.)
    const probe = this.getMayacli();
    const server = await this.ownerServer(probe, vol);
    const mayacli = server ? this.getMayacli([server]) : probe;

    // eager: for now queries for origin every delete
    // can be made to query on special error case
    const cloneOrigin = await mayacli.cloneOrigin(vol);

    // unbind needs the SAME clusterid the bind used -- they are all cluster resources, so an
    // unbind with a mismatched/absent clusterid is a no-op and delete mapping then EBUSYs.
    // Get the clusterid straight from the mapping's `c` field
    const maps = await mayacli.showMapping(vol);
    const m = maps.find((x) => x.n) || {};        // nvme mapping for the subsystem teardown below
    const cm = maps.find((x) => x.a) || maps[0];  // the active mapping (any protocol) carries `c`
    const clusterid = cm && cm.c != null ? cm.c : null;

    // unbind (with the mapping's clusterid) -> delete mapping. (idempotent: ignore ENOENT/EINVAL)
    await mayacli.unbindMapping(vol, clusterid);
    await mayacli.deleteMapping(vol);

    // block: tear down the per-PVC target + portal on every endpoint (HA pair holds
    // both). iscsi (iqn.) vs nvme-of (nqn.) use parallel verbs; tag = mapping tid,
    // fall back to the target parse.
    if (m.n) {
      const isIscsi = m.n.startsWith("iqn.");
      const sub = isIscsi
        ? (await mayacli.showIscsiTargets()).find((s) => s.iqn === m.n)
        : (await mayacli.showSubsystems()).find((s) => s.nqn === m.n);
      const portalTag =
        m.t != null ? m.t : sub && sub.portalTag != null ? sub.portalTag : null;
      for (const ep of this.endpoints()) {
        const cli = this.getMayacli([ep]);
        if (isIscsi) {
          await cli.deleteIscsiTarget(m.n);
          if (portalTag != null) await cli.deleteIscsiPortal(portalTag);
        } else {
          await cli.deleteSubsystem(m.n);
          if (portalTag != null) await cli.deletePortal(portalTag);
        }
      }
    }

    await mayacli.deleteVolume(vol);

    // reap the intermediate clonesnap (clonesnap- prefix only, never a user snapshot)
    if (cloneOrigin) {
      const snapBase = cloneOrigin.slice(cloneOrigin.lastIndexOf("@") + 1);
      if (snapBase.startsWith("clonesnap-")) {
        await mayacli.deleteSnapshot(cloneOrigin);
      }
    }

    await mayacli.save();
    return {};
  }

  async ControllerExpandVolume(call) {
    const vol = call.request.volume_id;
    if (!vol) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, "volume_id is required");
    }
    const capacity_bytes = this.capacityFromCall(call);
    // pin the resize to the volume's owner (no pool in the request -> derive from the volume)
    const probe = this.getMayacli();
    const server = await this.ownerServer(probe, vol);
    const mayacli = server ? this.getMayacli([server]) : probe;
    // set volume <vol> size=<n>G — configd dispatches volsize(zvol)/refquota(fs) by type
    await mayacli.setVolumeSize({
      vol,
      sizeG: Math.ceil(capacity_bytes / 1024 ** 3),
    });
    await mayacli.save();
    // block (zvol/vg) needs a node-side device rescan + fs resize after the server-side
    // size bump; an NFS/SMB share grows server-side via refquota (no node action). This must
    // match the node EXPAND_VOLUME cap, which is advertised only for resource type "volume".
    return {
      capacity_bytes: capacity_bytes,
      node_expansion_required: this.getDriverZfsResourceType() === "volume",
    };
  }

  async CreateSnapshot(call) {
    const source_volume_id = call.request.source_volume_id;
    const name = call.request.name;
    if (!source_volume_id || !name) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        "source_volume_id and name are required"
      );
    }
    // the snapshot is created in the SOURCE volume's pool -> pin to the source's owner
    const probe = this.getMayacli();
    const server = await this.ownerServer(probe, source_volume_id);
    const mayacli = server ? this.getMayacli([server]) : probe;
    const { srcKind, sizeBytes } = await mayacli.volSrcInfo(source_volume_id);
    // snapshot_id IS the configd label (lvSafeName keeps it LVM-legal)
    const mayaSnap = Mayacli.lvSafeName(
      Mayacli.snapName(srcKind, source_volume_id, name)
    );
    const snapshot_id = mayaSnap;
    let sin = await mayacli.showSnapshots(source_volume_id);
    let s = sin.find((x) => x.l === mayaSnap);
    if (!s) {
      // not on this source -> create (snapshot_id unique by construction; re-create idempotent)
      const opts = {
        name: srcKind === "vg" || srcKind === "thinpool" ? mayaSnap : name,
        vol: source_volume_id,
      };
      if (srcKind === "vg") {
        // a thick LVM snapshot needs a CoW area; default 25% of the source size
        const cowMiB = Math.max(1, Math.ceil((sizeBytes * 25) / 100 / (1024 * 1024)));
        opts.size = `${cowMiB}M`;
      }
      try {
        await mayacli.createSnapshot(opts);
      } catch (e) {
        // CSI_DEBUG_PANIC=1: freeze on create failure, skipping the known maxlen/EEXIST cases
        if (process.env.CSI_DEBUG_PANIC && name.length <= 127 && !/rc=17\b/.test(String(e && e.message))) {
          console.error(`[CSI_PANIC] CreateSnapshot failed name=${name} src=${source_volume_id} kind=${srcKind}: ${e && e.message}`);
          process.exit(43);
        }
        throw e;
      }
      sin = await mayacli.showSnapshots(source_volume_id);
      s = sin.find((x) => x.l === mayaSnap) || {};
    }
    // (already exists on this source -> idempotent return of the existing snapshot)
    return {
      snapshot: {
        snapshot_id,
        source_volume_id,
        creation_time: { seconds: Number(s.ct) || Math.floor(Date.now() / 1000), nanos: 0 },
        ready_to_use: true,
        size_bytes: Number(s.c) || 0,
      },
    };
  }

  async DeleteSnapshot(call) {
    const snapshot_id = call.request.snapshot_id;
    if (!snapshot_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, "snapshot_id is required");
    }
    // snapshot_id IS the configd label -> delete directly; pin to its owner (probe if gone)
    const probe = this.getMayacli();
    const server = await this.ownerServer(probe, snapshot_id);
    const mayacli = server ? this.getMayacli([server]) : probe;
    await mayacli.deleteSnapshot(snapshot_id);
    return {};
  }

  /**
   * ListSnapshots: snapshot_id (one) / source_volume_id (per-volume) / neither
   * (global enumerate). No pagination (all entries returned).
   */
  // V_SNAP record -> CSI snapshot entry; snapshot_id IS the configd label (rec.l)
  _snapEntry(rec, src) {
    const label = String(rec.l);
    const at = label.indexOf("@");
    const source = src || rec.sl || (at > 0 ? label.slice(0, at) : label);
    return {
      snapshot: {
        snapshot_id: label,
        source_volume_id: source,
        creation_time: { seconds: Number(rec.ct) || 0, nanos: 0 },
        ready_to_use: true,
        size_bytes: Number(rec.c) || 0,
      },
    };
  }

  async ListSnapshots(call) {
    const req = call.request;
    const probe = this.getMayacli();
    let entries;
    if (req.snapshot_id) {
      // snapshot_id IS the configd label -> one voldb lookup
      const rec = await probe.showVolume(req.snapshot_id);
      entries = rec ? [this._snapEntry(rec)] : [];
    } else if (req.source_volume_id) {
      // per-source GET -> pin to the source's owner
      const src = req.source_volume_id;
      const server = await this.ownerServer(probe, src);
      const cli = server ? this.getMayacli([server]) : probe;
      entries = (await cli.showSnapshots(src)).map((s) => this._snapEntry(s, src));
    } else {
      // global -> peer-synced voldb dump; vg source is best-effort (bare)
      const snaps = await probe.showSnapshotsAll();
      entries = snaps
        .filter((s) => !String(s.l).startsWith("__"))
        .map((s) => this._snapEntry(s));
    }
    return this._paginate(entries, req);
  }

  /** GetCapacity: pool free space (zpool root `cle`, or vg free). */
  async GetCapacity(call) {
    if (call.request.volume_capabilities) {
      const result = this.assertCapabilities(call.request.volume_capabilities);
      if (result.valid !== true) {
        return { available_capacity: 0 };
      }
    }
    const pool = _.get(call, "request.parameters.pool");
    if (!pool) {
      return { available_capacity: 0 };
    }
    const mayacli = this.getMayacli();
    // pool free space is a BACKEND read -- only the pool's OWNER has it. resolvePool
    // already returns the owner VIP; query there, NOT the default/first VIP (which
    // lacks the pool and would report 0). GetCapacity has the pool in parameters.
    const { kind, server } = await this.resolvePool(pool, mayacli);
    const ownerCli = server ? this.getMayacli([server]) : mayacli;
    if (kind === "zpool") {
      const zp = await ownerCli.showZpool(pool);
      const root =
        zp && Array.isArray(zp.zv) ? zp.zv.find((d) => d.n === pool) : null;
      return { available_capacity: root ? Number(root.cle) : 0 };
    }
    // vg (LVM / md raidgroup)
    const free = await ownerCli.vgFree(pool);
    return { available_capacity: Number(free) || 0 };
  }

  /** Provisioned capacity (bytes) of an existing volume from show-vol `c`; 0 if absent. */
  async existingCapacity(vol, mayacli) {
    const v = await mayacli.showVolume(vol); // targeted lookup, not a full-dump scan
    // `c` == vol_size (refquota for fs / volsize for block)
    return v ? Number(v.c) || 0 : 0;
  }

  /** CSI list pagination over a full entries array (index-based starting_token). */
  _paginate(entries, req) {
    let start = 0;
    if (req && req.starting_token) {
      start = Number(req.starting_token);
      if (!Number.isInteger(start) || start < 0 || start > entries.length) {
        throw new GrpcError(
          grpc.status.ABORTED,
          `invalid starting_token: ${req.starting_token}`
        );
      }
    }
    const max = Number(req && req.max_entries) || 0;
    const end = max > 0 ? start + max : entries.length;
    return {
      entries: entries.slice(start, end),
      next_token: end < entries.length ? String(end) : "",
    };
  }

  /** ControllerGetVolume: one volume by id; capacity from show-vol `c`, share = `d`. */
  async ControllerGetVolume(call) {
    const vol = call.request.volume_id;
    if (!vol) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, "volume_id is required");
    }
    const mayacli = this.getMayacli();
    // targeted single-volume lookup (voldb, peer-synced -> the default node answers) --
    // not a full `show vol` dump + scan.
    const v = await mayacli.showVolume(vol);
    if (!v) {
      throw new GrpcError(grpc.status.NOT_FOUND, `volume ${vol} not found`);
    }
    const isFs = this.getDriverZfsResourceType() === "filesystem";
    return {
      volume: {
        volume_id: vol,
        capacity_bytes: Number(v.c) || 0, // c == vol_size (refquota fs / volsize block)
        volume_context: isFs
          ? { node_attach_driver: "nfs", share: v.d }
          : { node_attach_driver: "nvmeof" },
      },
    };
  }

  /** ListVolumes: this driver's managed volumes (exclude __* and snapshots). No pagination. */
  async ListVolumes(call) {
    const mayacli = this.getMayacli();
    const isFs = this.getDriverZfsResourceType() === "filesystem";
    const types = this.driverVolTypes();
    const entries = (await mayacli.showVolumes())
      .filter((v) => types.includes(v.t) && !String(v.l).startsWith("__"))
      .map((v) => ({
        volume: {
          // `c` == vol_size (refquota for fs / volsize for block) = provisioned size
          volume_id: v.l,
          capacity_bytes: Number(v.c) || 0,
          volume_context: isFs
            ? { node_attach_driver: "nfs", share: v.d }
            : { node_attach_driver: "nvmeof" },
        },
      }));
    return this._paginate(entries, call.request);
  }

  async ValidateVolumeCapabilities(call) {
    const vol = call.request.volume_id;
    if (!vol) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, "volume_id is required");
    }
    const caps = call.request.volume_capabilities;
    if (!caps || caps.length === 0) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        "volume_capabilities are required"
      );
    }
    if (!(await this.getMayacli().volumeExists(vol))) {
      throw new GrpcError(grpc.status.NOT_FOUND, `volume ${vol} not found`);
    }
    const result = this.assertCapabilities(caps);
    if (result.valid !== true) {
      return { message: result.message };
    }
    return {
      confirmed: {
        volume_context: call.request.volume_context,
        volume_capabilities: caps,
        parameters: call.request.parameters,
      },
    };
  }
}

module.exports.ControllerZettalaneDriver = ControllerZettalaneDriver;
