//
// Copyright (c) 2026 ZettaLane Systems LLC. All rights reserved.
//
/**
 * mayacli — thin ONC/RPC client for the ZettaLane control plane (maya.configd)
 */

const cp = require("child_process");

// default location in zettalane-csi image bundle
const DEFAULT_BIN = "/usr/local/bin/mayacli";
const DEFAULT_TIMEOUT_S = 60;

// mayacli exits with the errno value; idempotency keys on this, not the message
const ERRNO = { EPERM: 1, ENOENT: 2, EBUSY: 16, EEXIST: 17, EINVAL: 22,
  EOPNOTSUPP: 95
};

// Volume types: the `t:` field in -j records
const VOL_TYPE = {
  UNKNOWN: 0, PROXY: 1, BLOCK: 2, FLEX: 3, SNAP: 4, FILE: 5, FILESYS: 6,
  KEYVAL: 7, ZVOL: 8, VDO: 9, BCACHE: 10, TAPEVOL: 11, RG: 12, VG: 13,
  ZPOOL: 14, THINPOOL: 15, KVSTORE: 16, TAPEDRV: 17, VTL: 18,
  ISCSI_NODE: 19, ISCSI_PORTAL: 20, NVMET_NODE: 21, NVMET_PORTAL: 22,
  CLOUD_NODE: 23, VDOPOOL: 24, GROUP: 25,
};

class Mayacli {
  /**
   * @param {object} opts {host, binPath?, timeout?, sudo?, logger?}
   *   host: endpoint(s) for `-h` (comma separated list for active-active )
   */
  constructor(opts = {}) {
    const hosts = (Array.isArray(opts.host) ? opts.host : String(opts.host || "").split(","))
      .map((h) => h.trim())
      .filter(Boolean);
    if (!hosts.length)
      throw new Error("Mayacli: opts.host (mgmt endpoint) is required");
    this.hosts = hosts;
    this.host = hosts[0]; // primary (logging / first attempt)
    this.binPath = opts.binPath || DEFAULT_BIN;
    this.timeout = opts.timeout || DEFAULT_TIMEOUT_S;
    this.sudo = !!opts.sudo;
    this.logger = opts.logger || { debug() {}, verbose() {}, error() {} };
  }

  /**
   * Run a verb, trying each host in order, failing over on
   * "cannot contact server" (control-plane HA).
   * Logical errors come from the first reachable host.
   * @returns {Promise<{code,stdout,stderr}>}
   */
  async exec(args, o = {}) {
    let last;
    for (let i = 0; i < this.hosts.length; i++) {
      last = await this._execOnHost(this.hosts[i], args, o);
      const unreachable = /Cannot contact mayastor server/i.test(
        (last.stderr || "") + (last.stdout || "")
      );
      if (!unreachable || i === this.hosts.length - 1)
        return last;
      this.logger.verbose(
        "mayacli: host %s unreachable, failover -> %s",
        this.hosts[i],
        this.hosts[i + 1]
      );
    }
    return last;
  }

  _execOnHost(host, args, o = {}) {
    const timeout = o.timeout || this.timeout;
    const global = ["-h", host, "-t", String(timeout)];
    if (o.force) global.push("-f");
    const fullArgs = [...global, ...args];

    let bin = this.binPath;
    let spawnArgs = fullArgs;
    if (this.sudo) {
      bin = "sudo";
      spawnArgs = [this.binPath, ...fullArgs];
    }

    this.logger.verbose("mayacli exec: %s %s", bin, spawnArgs.join(" "));

    return new Promise((resolve, reject) => {
      const child = cp.spawn(bin, spawnArgs, { env: process.env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        this.logger.debug("mayacli rc=%d stdout=%j stderr=%j", code, stdout, stderr);
        resolve({ code, stdout, stderr });
      });
      // hard wall-clock guard slightly above the mayacli -t value
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (e) {}
        reject(new Error(`mayacli timed out after ${timeout + 15}s: ${args.join(" ")}`));
      }, (timeout + 15) * 1000).unref();
    });
  }

  /** exec and throw on non-zero unless the exit code is in `ignoreCodes`
   * (errno, for idempotency -- e.g. ENOENT on delete of an absent object). */
  async execOk(args, o = {}) {
    const r = await this.exec(args, o);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || "").trim();
      if (o.ignoreCodes && o.ignoreCodes.includes(r.code)) {
        this.logger.verbose("mayacli ignorable rc=%d: %s", r.code, msg);
        return r;
      }
      // log BOTH streams (mayacli puts errors on stderr, data on stdout)
      this.logger.error(
        "mayacli failed rc=%d: %s :: stderr=%j stdout=%j",
        r.code,
        args.join(" "),
        (r.stderr || "").trim(),
        (r.stdout || "").trim()
      );
      const err = new Error(`mayacli failed (rc=${r.code}): ${args.join(" ")} :: ${msg}`);
      err.code = r.code;
      err.stderr = (r.stderr || "").trim();
      err.stdout = (r.stdout || "").trim();
      throw err;
    }
    return r;
  }

  // ---- options string helper -------------------------------------------------
  // options='"k=v ..."'; passed as one argv element (spawn, no shell quoting needed)
  static opt(s) {
    return `options=${s}`;
  }

  // ---- volume ----------------------------------------------------------------
  /**
   * Provision a volume: result type follows access (filesystem -> V_FILESYS,
   * block -> V_FLEX), container keyword follows kind. Thick unless a.thin.
   * @param {object} a {label, container:{kind,name}, access, sizeBytes,
   *                     recordsize?, thin?, thinpool?, clusterid?}
   */
  async createVolume(a) {
    const { kind, name } = a.container;
    // kind is the mayacli container keyword directly: `zpool=` (alias of zp=) or `vg=`.
    const container = `${kind}=${name}`;
    const args = ["create", "volume", a.label];

    if (a.access === "filesystem") {
      if (kind === "zpool") {
        const opts = [];
        if (a.recordsize) opts.push(`-o recordsize=${a.recordsize}`);
        if (a.sizeBytes) opts.push(`-o refquota=${a.sizeBytes}`); // cap
        if (a.sizeBytes && !a.thin) opts.push(`-o refreservation=${a.sizeBytes}`); // thick
        args.push("filesys=zfs", container);
        if (a.clusterid != null) args.push(`clusterid=${a.clusterid}`);
        if (opts.length) args.push(Mayacli.opt(`"${opts.join(" ")}"`));
      } else {
        // XFS on an LVM LV (the LV is V_FLEX under a V_FILESYS xfs)
        args.push("filesys=xfs", a.thin && a.thinpool ? `thinpool=${a.thinpool}` : container);
        if (a.sizeBytes) args.push(`size=${a.sizeBytes}`);
        if (a.clusterid != null) args.push(`clusterid=${a.clusterid}`);
      }
    } else {
      // block (V_FLEX): zvol on a zpool, or LV on a VG
      args.push(a.thin && a.thinpool ? `thinpool=${a.thinpool}` : container);
      if (a.sizeBytes) args.push(`size=${a.sizeBytes}`);
      // add zpool zvol sparse option if thin requested
      if (kind === "zpool" && a.thin) args.push(Mayacli.opt('"-s"'));
      if (a.clusterid != null) args.push(`clusterid=${a.clusterid}`);
    }
    // idempotency is the caller's job (check-first); a stray EEXIST is a real race -> surface it
    return this.execOk(args, { force: true });
  }

  /**
   * Clone a snapshot into a new volume via `copy snapshot`;
   * configd auto-registers the clone. Grow to requested size after,
   * if larger than the inherited size.
   * @param {object} a {snapshotof, label, vol?, sizeG?}
   */
  async createVolumeFromSnapshot(a) {
    // a.snapshotof = the per-kind snapshot id;
    // a.label = the new bare volume label
    await this.execOk(["copy", "snapshot", a.snapshotof, a.label]);
    // optional grow-to-requested; skipped for vg (async dd in flight)
    if (a.sizeG && a.vol) {
      await this.execOk(["set", "volume", a.vol, `size=${a.sizeG}G`]);
    }
  }

  /** `set volume <vol> size=<n>G`; configd dispatches
   * volsize(zvol)/refquota(fs) by type. */
  async setVolumeSize(a) {
    if (!a.sizeG) throw new Error("setVolumeSize: size (e.g. {sizeG}) required");
    return this.execOk(["set", "volume", a.vol, `size=${a.sizeG}G`]);
  }

  async deleteVolume(vol) {
    return this.execOk(["delete", "volume", vol], { ignoreCodes: [ERRNO.ENOENT] });
  }

  /** True if the volume exists (show volume <absent> -> ENOENT(2); key on the code). */
  async volumeExists(vol) {
    const r = await this.exec(["show", "volume", vol]);
    if (r.code === 0) return true;
    if (r.code === ERRNO.ENOENT) return false;
    // unknown error — surface it
    throw new Error(
      `mayacli show volume ${vol} failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
    );
  }

  // ---- discovery: derive pools->{clusterid,vip} from the cluster ----
  /**
   * Parse mayacli `-j` output (a V()/M() JS-callback program, NOT JSON) by
   * defining V/M as collectors and eval-ing each record (safe: our own output).
   * Returns a dict keyed by type (data.vols, data.failoverinfo).
   */
  parseJ(output) {
    const data = {};
    let mayaout = "";
    /* eslint-disable no-unused-vars */
    const M = (type, obj) => {
      (data[type] = data[type] || []).push(obj);
    };
    const V = (type, name, body) => {
      let obj = typeof body === "string" ? {} : body || {};
      if (typeof body === "string") {
        try {
          obj = eval("(" + body + ")");
        } catch (e) {
          obj = {};
        }
      }
      if (obj.name === undefined) obj.name = name;
      (data[type] = data[type] || []).push(obj);
    };
    /* eslint-enable no-unused-vars */
    // a record may span multiple lines (e.g. failover) ->
    // accumulate to the ");" terminator before eval
    let buf = "";
    for (const line of String(output || "").split("\n")) {
      buf += (buf ? "\n" : "") + line;
      const t = buf.trim();
      if (/^[MV]\(/.test(t)) {
        if (/\);\s*$/.test(t)) {
          try {
            eval(t); // calls M()/V() above
          } catch (e) {
            /* skip a malformed record */
          }
          buf = "";
        }
        // else: incomplete record -> keep accumulating lines
      } else {
        if (t) mayaout += (mayaout ? "\n" : "") + t;
        buf = "";
      }
    }
    Object.defineProperty(data, "mayaout", { value: mayaout, enumerable: false });
    return data;
  }

  /** Pool's {clusterid, kind} via `-j show volume <pool>` (kind = the container keyword). */
  async getPoolInfo(pool) {
    const r = await this.exec(["-j", "show", "volume", pool]);
    if (r.code !== 0) {
      const e = new Error(
        `mayacli -j show volume ${pool} failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
      );
      e.code = r.code;
      throw e;
    }
    const data = this.parseJ(r.stdout);
    const list = data.volfullinfo || data.vols || [];
    const z = list.find((v) => v.l === pool || v.name === pool);
    if (!z || z.cid == null) {
      throw new Error(`pool '${pool}' not found (or no clusterid) via mayacli show volume`);
    }
    let kind;
    if (z.t === VOL_TYPE.ZPOOL) kind = "zpool";
    else if (z.t === VOL_TYPE.THINPOOL) kind = "thinpool"; // thin LV: container=thinpool=<pool>
    else if (z.t === VOL_TYPE.VG || z.t === VOL_TYPE.RG) kind = "vg";
    else throw new Error(`pool '${pool}' has unsupported vol_type ${z.t} (expected zpool/vg/thinpool)`);
    return { clusterid: Number(z.cid), kind };
  }

  /** Backing {srcKind, sizeBytes} of a VOLUME via `-j show volume <vol>` (`st`=srcvol_type, `c`=size). */
  async volSrcInfo(volId) {
    const r = await this.exec(["-j", "show", "volume", volId]);
    if (r.code !== 0) {
      const e = new Error(
        `mayacli -j show volume ${volId} failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
      );
      e.code = r.code;
      throw e;
    }
    const v = (this.parseJ(r.stdout).volfullinfo || []).find((x) => x.l === volId) || {};
    let srcKind = "zpool";
    if (v.st === VOL_TYPE.VG || v.st === VOL_TYPE.RG) srcKind = "vg";
    else if (v.st === VOL_TYPE.THINPOOL) srcKind = "thinpool"; // thin LV: bare names, sizeless snap, native clone
    return { srcKind, sizeBytes: Number(v.c) || 0 };
  }

  /**
   * A single volume's full voldb record via `-j show volume <label>` (TARGETED -- avoids
   * dumping all of `show vol` and scanning). Returns the volfullinfo record
   * {l, c (size), d (dev/share), cid, ct, st, sl, ...} or null if absent (ENOENT). The
   * voldb is peer-synced, so any node answers.
   */
  async showVolume(label) {
    const r = await this.exec(["-j", "show", "volume", label]);
    if (r.code !== 0) {
      if (r.code === ERRNO.ENOENT) return null; // not found -> null (no scan, no throw)
      const e = new Error(
        `mayacli -j show volume ${label} failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
      );
      e.code = r.code;
      throw e;
    }
    return (this.parseJ(r.stdout).volfullinfo || []).find((x) => x.l === label) || null;
  }

  /** Failover map {mapid(==clusterid): virtip(==data VIP)} from `-j show failover`. */
  async showFailover() {
    const r = await this.exec(["-j", "show", "failover"]);
    const byMapid = {};
    if (r.code === 0) {
      // failoverinfo[].nodestat[] = {mapid(==clusterid), virtip(==data VIP)}
      for (const fo of this.parseJ(r.stdout).failoverinfo || []) {
        const ns = Array.isArray(fo.nodestat) ? fo.nodestat : [];
        for (const n of ns) {
          if (n.mapid != null && n.mapid !== "" && n.virtip) {
            byMapid[String(n.mapid)] = n.virtip;
          }
        }
      }
    }
    return { byMapid };
  }

  /** All volumes via `-j show vol` -> data.vols [{t,l,d,c,gid,cid}]; snapshots appear as t=SNAP. */
  async showVolumes() {
    const r = await this.exec(["-j", "show", "vol"]);
    if (r.code !== 0) {
      const e = new Error(`mayacli -j show vol failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`);
      e.code = r.code;
      throw e;
    }
    return this.parseJ(r.stdout).vols || [];
  }

  /** Snapshots of a volume via `-j show snapshot <vol>` -> the snapvolinfo `sin[]`; `l` = the id. */
  async showSnapshots(vol) {
    const r = await this.exec(["-j", "show", "snapshot", vol]);
    if (r.code !== 0) {
      // ENOENT(2)/EFAULT(14) = no snapshots to report -> [] (don't fail the whole list)
      if (r.code === ERRNO.ENOENT || r.code === 14) return [];
      const e = new Error(
        `mayacli -j show snapshot ${vol} failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
      );
      e.code = r.code;
      throw e;
    }
    const info = (this.parseJ(r.stdout).snapvolinfo || [])[0];
    return info && Array.isArray(info.sin) ? info.sin : [];
  }

  /**
   * All snapshots cluster-wide via `-j show vol type=4` (V_SNAP entries). This reads the
   * VOLDB, peer-synced to EVERY node -> ANY node answers, even one without the pool's backend
   * -- unlike `show snapshot [<vol>]`, which does a per-source BACKEND GET that err=14s
   * off-owner (so it can't serve a context-free, owner-agnostic list). The basic record now
   * carries `ct` (create time). Each entry: {t:4, l (= "<src>@<name>" for zpool), d, c (size),
   * ct, cid}. Used by ListSnapshots, which has no pool context to pin to.
   */
  async showSnapshotsAll() {
    const r = await this.exec(["-j", "show", "vol", "type=4"]);
    if (r.code !== 0) {
      const e = new Error(
        `mayacli -j show vol type=4 failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
      );
      e.code = r.code;
      throw e;
    }
    return this.parseJ(r.stdout).vols || [];
  }

  /** Pool detail via `-j show zpool <pool>` -> the record with `zv:[{n,size,cle}]`; `cle`=available. */
  async showZpool(pool) {
    const r = await this.exec(["-j", "show", "zpool", pool]);
    if (r.code !== 0) {
      const e = new Error(
        `mayacli -j show zpool ${pool} failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
      );
      e.code = r.code;
      throw e;
    }
    return (this.parseJ(r.stdout).zpool || [])[0] || null;
  }

  /** Free bytes of a VG via `-j show vg <vg>`: free extents (pef) * extent size (pes). */
  async vgFree(vg) {
    const r = await this.exec(["-j", "show", "vg", vg]);
    if (r.code !== 0) {
      if (r.code === ERRNO.ENOENT) return 0;
      const e = new Error(
        `mayacli -j show vg ${vg} failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
      );
      e.code = r.code;
      throw e;
    }
    const rec = (this.parseJ(r.stdout).vg || [])[0];
    return rec ? Number(rec.pef) * Number(rec.pes) : 0;
  }

  // ---- mapping (export) ------------------------------------------------------
  /**
   * Create an export mapping for a volume.
   * @param {object} a {vol, controller ('nfs'|'nfs3'|'smb'|'iscsi'|'nvmet'), clusterid, options, extra[]}
   */
  async createMapping(a) {
    const args = ["create", "mapping", `volume=${a.vol}`, `controller=${a.controller}`];
    if (a.clusterid != null) args.push(`clusterid=${a.clusterid}`);
    for (const e of a.extra || []) args.push(e); // e.g. profile=posix, lun=0, nodename=...
    // options value carries literal surrounding double-quotes; spawn passes argv directly (no shell)
    if (a.options) args.push(Mayacli.opt(`"${a.options}"`));
    // reached only on a fresh create -> let EEXIST surface like createVolume
    return this.execOk(args);
  }

  /** Activate a mapping. A clusterid= volume MUST bind with clusterid= (apply on the HA resource). */
  async bindMapping(vol, clusterid) {
    const args = ["bind", "mapping", vol];
    if (clusterid != null) args.push(`clusterid=${clusterid}`);
    return this.execOk(args);
  }

  /** Mapping records via `-j show mapping <vol>` -> data.maps [{v,d,ty,a,l(nsid),n(nqn)}]. */
  async showMapping(vol) {
    const r = await this.exec(["-j", "show", "mapping", vol]);
    if (r.code !== 0) {
      if (r.code === ERRNO.ENOENT) return [];
      const e = new Error(
        `mayacli -j show mapping ${vol} failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
      );
      e.code = r.code;
      throw e;
    }
    return this.parseJ(r.stdout).maps || [];
  }

  async unbindMapping(vol, clusterid) {
    // unbind must carry the SAME clusterid as the bind, else the namespace pins the LV (delete EBUSY);
    // an absent/already-unbound mapping (EINVAL/ENOENT) is idempotent
    const args = ["unbind", "mapping", vol];
    if (clusterid != null) args.push(`clusterid=${clusterid}`);
    return this.execOk(args, { ignoreCodes: [ERRNO.ENOENT, ERRNO.EINVAL] });
  }

  async deleteMapping(vol) {
    return this.execOk(["delete", "mapping", vol], { ignoreCodes: [ERRNO.ENOENT] });
  }

  // ---- nvmet portal + per-PVC subsystem (block / nvme-of) --------------------
  /** Per-PVC subsystem NQN. Full NQN, verbatim (configd nvmet.c requires nqn./eui.). */
  static csiNqn(volid) {
    return `nqn.2026-06.com.zettalane-csi:${volid}`;
  }

  /** Parse `-j show nvmet portal` -> [{tag, ip, port}]. */
  async showPortals() {
    const r = await this.exec(["-j", "show", "nvmet", "portal"]);
    const out = [];
    for (const m of (r.stdout || "").matchAll(/\{t:(\d+),p:"([^":]+):(\d+)"\}/g)) {
      out.push({ tag: Number(m[1]), ip: m[2], port: Number(m[3]) });
    }
    return out;
  }

  /** Targets via `-j show nvmet` -> [{nqn, portalTag, portalPort}]. The `ip` field encodes
   * "{<ip>:<port>}<tag>", so we recover which portal a subsystem sits on (for teardown). */
  async showSubsystems() {
    const r = await this.exec(["-j", "show", "nvmet"]);
    if (r.code !== 0) return [];
    const targets = this.parseJ(r.stdout).ntargets || [];
    return targets.map((t) => {
      const m = /\{[^:]+:(\d+)\}(\d+)/.exec(t.ip || "");
      return { nqn: t.n, portalPort: m ? Number(m[1]) : null, portalTag: m ? Number(m[2]) : null };
    });
  }

  /**
   * Per-PVC portal via `portalgroup=auto` (configd allocates tag+port); diff portals
   * before/after to recover the new {tag,port}. (Concurrent PVCs need an echo'd tag — TODO.)
   */
  async createPortalAuto(vip) {
    const before = new Set(
      (await this.showPortals()).filter((p) => p.ip === vip).map((p) => p.tag)
    );
    await this.execOk(["create", "nvmet", "portalgroup=auto", `portal=${vip}`]);
    const fresh = (await this.showPortals()).filter((p) => p.ip === vip && !before.has(p.tag));
    if (!fresh.length) {
      throw new Error(`createPortalAuto: no new portal read back on ${vip}`);
    }
    return fresh.sort((a, b) => b.tag - a.tag)[0]; // newest
  }

  /** Create the per-PVC subsystem (full NQN) on a portal group tag. Idempotent: an existing
   * subsystem (retry / peer-push) is benign -- no spec to conflict, unlike a volume. */
  async createSubsystem(nqn, tag) {
    return this.execOk(["create", "nvmet", `nodename=${nqn}`, `portalgroup=${tag}`], {
      ignoreCodes: [ERRNO.EEXIST],
    });
  }

  /** Create a portal with an EXPLICIT tag+port (for pushing node1's allocation to the peer). */
  async createPortal(tag, vip, port) {
    return this.execOk(["create", "nvmet", `portalgroup=${tag}`, `portal=${vip}:${port}`], {
      ignoreCodes: [ERRNO.EEXIST],
    });
  }

  async deleteSubsystem(nqn) {
    return this.execOk(["delete", "nvmet", `nodename=${nqn}`], { ignoreCodes: [ERRNO.ENOENT] });
  }

  async deletePortal(tag) {
    return this.execOk(["delete", "nvmet", `portalgroup=${tag}`], { ignoreCodes: [ERRNO.ENOENT] });
  }

  // ---- snapshots -------------------------------------------------------------
  /**
   * The mayacli snapshot id by backend (analogue of configd's snapname()):
   * zfs -> "<sourceVol>@<name>", vg/thinpool -> bare "<name>".
   */
  static snapName(srcKind, sourceVol, name) {
    // LVM (thick vg or thin pool) snapshot LVs use the bare name; zfs uses <vol>@<name>.
    return srcKind === "vg" || srcKind === "thinpool" ? name : `${sourceVol}@${name}`;
  }

  /** create snapshot <name> snapshotof=<vol> [size=<sz>]  (size: full unit string, e.g. "256M") */
  async createSnapshot(a) {
    const args = ["create", "snapshot", a.name, `snapshotof=${a.vol}`];
    if (a.size) args.push(`size=${a.size}`);
    else if (a.sizeG) args.push(`size=${a.sizeG}G`);
    return this.execOk(args);
  }

  async deleteSnapshot(nameOrVol) {
    return this.execOk(["delete", "snapshot", nameOrVol], {
      force: true,
      ignoreCodes: [ERRNO.ENOENT],
    });
  }

  // ---- persist ---------------------------------------------------------------
  async save() {
    return this.execOk(["save"]);
  }
}

module.exports.Mayacli = Mayacli;
module.exports.VOL_TYPE = VOL_TYPE;
module.exports.ERRNO = ERRNO;
