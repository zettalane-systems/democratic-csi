const _ = require("lodash");
const { GrpcError, grpc } = require("../../utils/grpc");
const { CsiBaseDriver } = require("../index");
const { Mayacli } = require("../../utils/mayacli");

/**
 * controller-zettalane — CSI driver for the Maya family (MayaNAS / MayaScale) over `mayacli`.
 *
 * ONE class, multiple product drivers selected by `options.driver` (factory.js):
 *   - mayanas         : ZFS backend; StorageClass .parameters.protocol = nfs|smb|iscsi|nvmeof
 *   - mayascale       : md/RAID block; protocol = iscsi|nvmeof   (no snapshot/clone/expand)
 *   - mayanas-lustre  : client mount of the auto-managed `zettafs` (separate caps)
 *
 * Modeled on freenas/api.js (extends CsiBaseDriver, calls a backend client) but the client is
 * `mayacli` (ONC/RPC, no SSH) instead of HTTP. Node attach is the GENERIC node plugin — we only
 * set volume_context.node_attach_driver.
 *
 * STATUS: mayanas + protocol=nfs implemented. Other protocols/products throw UNIMPLEMENTED.
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

    if (!("rpc" in options.service.identity.capabilities)) {
      options.service.identity.capabilities.rpc = [
        "CONTROLLER_SERVICE",
        // "VOLUME_ACCESSIBILITY_CONSTRAINTS",  // enable with the zone_cluster_map port
      ];
    }

    if (!("rpc" in options.service.controller.capabilities)) {
      options.service.controller.capabilities.rpc = [
        "CREATE_DELETE_VOLUME",
        "CREATE_DELETE_SNAPSHOT",
        "LIST_SNAPSHOTS",
        "CLONE_VOLUME",
        "EXPAND_VOLUME", // fs expand needs the configd refquota branch; zvol works today
      ];
    }

    if (!("rpc" in options.service.node.capabilities)) {
      options.service.node.capabilities.rpc = [
        "STAGE_UNSTAGE_VOLUME",
        "EXPAND_VOLUME",
      ];
    }
  }

  // ---- helpers --------------------------------------------------------------

  /** mayacli client, configured from the driver Secret (options.mayacli). */
  getMayacli() {
    const m = _.get(this.options, "mayacli", {});
    if (!m.host) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        "invalid configuration: options.mayacli.host (mgmt endpoint) is required"
      );
    }
    return new Mayacli({
      host: m.host,
      binPath: m.path,
      timeout: m.timeout,
      sudo: m.sudo,
      logger: this.ctx.logger,
    });
  }

  /**
   * Resolve a pool to {clusterid, server(=data VIP)}, two sources in order:
   *  1. explicit driver config options.pools[pool] (the TF csi_backend handoff); or
   *  2. live DISCOVERY via mayacli — clusterid = the zpool's cid, vip = the failover node
   *     whose mapid == that clusterid (single-node/no-HA -> fall back to the mgmt host).
   * (2) lets the Secret carry only mayacli.host (Trident-style), decoupling the K8s admin
   * from the MayaNAS terraform state. Cached per pool for the controller's lifetime.
   */
  async resolvePool(pool, mayacli) {
    const cfg = _.get(this.options, ["pools", pool]);
    if (cfg && cfg.clusterid != null && cfg.vip) {
      return { clusterid: cfg.clusterid, server: cfg.vip };
    }
    this._poolCache = this._poolCache || {};
    if (this._poolCache[pool]) return this._poolCache[pool];

    mayacli = mayacli || this.getMayacli();
    let clusterid, server;
    try {
      clusterid = await mayacli.getPoolClusterid(pool);
      const fo = await mayacli.showFailover();
      server = fo.byMapid[String(clusterid)] || _.get(this.options, "mayacli.host");
    } catch (e) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `pool '${pool}' not in driver config and discovery failed (${e.message}); set ` +
          `options.pools[${pool}]={clusterid,vip} or ensure the zpool exists on the cluster`
      );
    }
    if (!server) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `pool '${pool}': could not determine data VIP (failover empty and no mayacli.host)`
      );
    }
    const resolved = { clusterid, server };
    this._poolCache[pool] = resolved;
    return resolved;
  }

  /** Resolve the access protocol for this volume (PowerStore-style param within mayanas). */
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

  /** Build the NFS export options, ensuring fsid=<clusterid> for NFSv4 failover. */
  buildNfsOptions(rawOpts, clusterid) {
    let opts = rawOpts || "*(rw,sync,no_root_squash)";
    if (!/fsid=/.test(opts)) {
      // insert fsid before the final ')'  (matches cluster_setup2.sh)
      opts = opts.replace(/\)\s*$/, `,fsid=${clusterid})`);
    }
    return opts;
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

  async CreateVolume(call) {
    const driver = this;
    const protocol = this.getProtocol(call);
    if (this.options.driver !== "mayanas" || protocol !== "nfs") {
      throw new GrpcError(
        grpc.status.UNIMPLEMENTED,
        `driver=${this.options.driver} protocol=${protocol} not implemented yet (mayanas/nfs only)`
      );
    }

    if (
      !call.request.volume_capabilities ||
      call.request.volume_capabilities.length === 0
    ) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, "missing volume_capabilities");
    }

    const mayacli = this.getMayacli();
    const label = await driver.getVolumeIdFromCall(call); // sanitized pvc name
    const pool = this.reqParam(call, "pool");
    // clusterid + data VIP come from the driver config (TF csi_backend handoff) OR are
    // discovered live from the cluster via mayacli (Trident-style) — see resolvePool().
    const { clusterid, server } = await this.resolvePool(pool, mayacli);
    const recordsize = _.get(call, "request.parameters.recordsize", "128K");
    const capacity_bytes = this.capacityFromCall(call);

    const vol = `${pool}-${label}`; // pool-prefixed volname (avoids cross-pool collisions)
    const share = `/${pool}/${label}`;
    const content_source = call.request.volume_content_source;

    // idempotency: if the volume already exists, return success (assume same spec)
    const exists = await mayacli.volumeExists(vol);
    if (!exists) {
      if (content_source && content_source.snapshot) {
        // CLONE_VOLUME from a snapshot
        await mayacli.createVolumeFromSnapshot({
          label,
          pool,
          clusterid,
          snapshotof: content_source.snapshot.snapshot_id,
          sizeG: Math.ceil(capacity_bytes / 1024 ** 3),
        });
      } else {
        await mayacli.createZfsVolume({
          pool,
          label,
          clusterid,
          recordsize,
          refquotaBytes: capacity_bytes,
        });
      }
      await mayacli.createMapping({
        vol,
        controller: "nfs",
        clusterid,
        options: this.buildNfsOptions(
          _.get(call, "request.parameters.nfsOptions"),
          clusterid
        ),
      });
      await mayacli.bindMapping(vol);
      await mayacli.save();
    }

    const volume_context = {
      node_attach_driver: "nfs",
      server: server,
      share: share,
    };

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

    const mayacli = this.getMayacli();
    // unbind -> delete mapping -> delete volume (all idempotent: ignore ENOENT)
    await mayacli.unbindMapping(vol);
    await mayacli.deleteMapping(vol);
    await mayacli.deleteVolume(vol);
    await mayacli.save();
    return {};
  }

  async ControllerExpandVolume(call) {
    const vol = call.request.volume_id;
    if (!vol) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, "volume_id is required");
    }
    const capacity_bytes = this.capacityFromCall(call);
    const mayacli = this.getMayacli();
    // set volume <vol> size=<n>G — configd dispatches volsize(zvol)/refquota(fs) by type
    await mayacli.setVolumeSize({
      vol,
      sizeG: Math.ceil(capacity_bytes / 1024 ** 3),
    });
    await mayacli.save();
    return {
      capacity_bytes: capacity_bytes,
      node_expansion_required: false, // nfs: server-side quota, no node action
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
    const mayacli = this.getMayacli();
    await mayacli.createSnapshot({ name, vol: source_volume_id });
    return {
      snapshot: {
        snapshot_id: name,
        source_volume_id: source_volume_id,
        creation_time: { seconds: Math.floor(Date.now() / 1000), nanos: 0 },
        ready_to_use: true,
        size_bytes: 0,
      },
    };
  }

  async DeleteSnapshot(call) {
    const snapshot_id = call.request.snapshot_id;
    if (!snapshot_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, "snapshot_id is required");
    }
    const mayacli = this.getMayacli();
    await mayacli.deleteSnapshot(snapshot_id);
    return {};
  }

  async ValidateVolumeCapabilities(call) {
    const result = this.assertCapabilities(call.request.volume_capabilities || []);
    if (result.valid !== true) {
      return { message: result.message };
    }
    return {
      confirmed: {
        volume_context: call.request.volume_context,
        volume_capabilities: call.request.volume_capabilities,
        parameters: call.request.parameters,
      },
    };
  }
}

module.exports.ControllerZettalaneDriver = ControllerZettalaneDriver;
