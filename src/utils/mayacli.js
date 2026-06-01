/**
 * mayacli — thin client for the MayaNAS/MayaScale control plane (maya.configd).
 *
 * mayacli is an ONC/RPC client (over portmapper/rpcbind, passwordless — NO SSH). This wrapper
 * execs the LOCAL `mayacli` binary with `-h <host>` so the controller pod drives a remote node's
 * configd. It is the analog of freenas/api.js's httpClient: the driver calls these verb methods
 * instead of HTTP.
 *
 * Client ACL = TCP wrappers (/etc/hosts.allow) on the MayaNAS node, scoped to the controller's
 * source range. Bundle the mayacli binary in the CONTROLLER image (not the Helm chart).
 *
 * Verb syntax is taken from builder/mayastor/cmds/config/cluster_setup2.sh + regression/tests.
 * Items marked CONFIRM need validation on a live pair.
 */

const cp = require("child_process");

const DEFAULT_BIN = "/opt/mayastor/bin/mayacli";
const DEFAULT_TIMEOUT_S = 60;

// mayacli exits with the errno value (the same code->name map mayatest uses in
// the regression harness). Idempotency keys on the CODE, not message text:
// mayacli never prints the string "ENOENT" -- it prints a human message and
// exits with the errno (e.g. show/delete of an absent object -> ENOENT(2);
// unbind of an already-unbound mapping -> EINVAL(22)).
const ERRNO = { EPERM: 1, ENOENT: 2, EBUSY: 16, EEXIST: 17, EINVAL: 22, EOPNOTSUPP: 95 };

class Mayacli {
  /**
   * @param {object} opts
   * @param {string} opts.host        mgmt endpoint (VIP or node IP) for `-h`
   * @param {string} [opts.binPath]   path to mayacli (default /opt/mayastor/bin/mayacli)
   * @param {number} [opts.timeout]   default per-call timeout in seconds (mayacli -t)
   * @param {boolean}[opts.sudo]      prefix with sudo
   * @param {object} [opts.logger]    logger with .debug/.verbose/.error (optional)
   */
  constructor(opts = {}) {
    if (!opts.host) throw new Error("Mayacli: opts.host (mgmt endpoint) is required");
    this.host = opts.host;
    this.binPath = opts.binPath || DEFAULT_BIN;
    this.timeout = opts.timeout || DEFAULT_TIMEOUT_S;
    this.sudo = !!opts.sudo;
    this.logger = opts.logger || { debug() {}, verbose() {}, error() {} };
  }

  /**
   * Run mayacli with global flags prepended: [sudo] mayacli -h <host> [-t <sec>] [-f] <args...>
   * @param {string[]} args  e.g. ["create","volume","myvol","filesys=zfs","zp=pool"]
   * @param {object} [o]     { timeout, force }
   * @returns {Promise<{code:number, stdout:string, stderr:string}>}
   */
  exec(args, o = {}) {
    const timeout = o.timeout || this.timeout;
    const global = ["-h", this.host, "-t", String(timeout)];
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
      // visible on failure (mayacli puts errors on stderr, data on stdout) --
      // log BOTH streams so nothing is lost if a verb ever splits output.
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
  // mayacli takes options='"k=v ..."' / options='"-o zfsprop=val"'. We pass the inner
  // string as a single argv element so no shell quoting is needed (spawn, not shell).
  static opt(s) {
    return `options=${s}`;
  }

  // ---- volume ----------------------------------------------------------------
  /**
   * Create a ZFS filesystem volume in a pool. Resulting volname = `<pool>-<label>_fs` (CONFIRM _fs),
   * dataset `<pool>/<label>_fs`, mountpoint `/<pool>/<label>_fs`.
   * @param {object} a {pool, label, clusterid, recordsize, refquotaBytes}
   */
  async createZfsVolume(a) {
    const opts = [];
    if (a.recordsize) opts.push(`-o recordsize=${a.recordsize}`);
    // size cap: opts pass straight to `zfs create -o ...` (zpool.c:2401 zvol_create_fs)
    if (a.refquotaBytes) opts.push(`-o refquota=${a.refquotaBytes}`);
    const args = ["create", "volume", a.label, "filesys=zfs", `zp=${a.pool}`];
    if (a.clusterid != null) args.push(`clusterid=${a.clusterid}`);
    if (opts.length) args.push(Mayacli.opt(`"${opts.join(" ")}"`));
    return this.execOk(args, { force: true });
  }

  /** Clone: create a new volume from a snapshot (CSI CLONE_VOLUME / volume_content_source). */
  async createVolumeFromSnapshot(a) {
    const args = ["create", "volume", a.label, `snapshotof=${a.snapshotof}`];
    if (a.sizeG) args.push(`size=${a.sizeG}G`);
    if (a.clusterid != null) args.push(`clusterid=${a.clusterid}`);
    if (a.pool) args.push(`zp=${a.pool}`);
    return this.execOk(args, { force: true });
  }

  /**
   * ControllerExpandVolume — `set volume <vol> size=<n>G`. configd dispatches by volume type:
   * zvol -> `zfs set volsize=` (zpool.c:2240 zvol_set_size, today); filesystem -> `zfs set refquota=`
   * (small branch to ADD in zvol_set_size keyed on zv_type). Same verb for block + file once the fs
   * branch lands; until then it is zvol-only.
   */
  async setVolumeSize(a) {
    if (!a.sizeG) throw new Error("setVolumeSize: size (e.g. {sizeG}) required");
    return this.execOk(["set", "volume", a.vol, `size=${a.sizeG}G`]);
  }

  async deleteVolume(vol) {
    return this.execOk(["delete", "volume", vol], { ignoreCodes: [ERRNO.ENOENT] });
  }

  /** Returns true if the volume exists. `show volume <absent>` exits ENOENT(2)
   * with a human message ("Cannot obtain information on volume <v>") -- so key
   * on the errno code, not the message string (verified on live mayacli). */
  async volumeExists(vol) {
    const r = await this.exec(["show", "volume", vol]);
    if (r.code === 0) return true;
    if (r.code === ERRNO.ENOENT) return false;
    // unknown error — surface it
    throw new Error(
      `mayacli show volume ${vol} failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
    );
  }

  // ---- discovery (Trident-style: derive pools->{clusterid,vip} from the cluster) ----
  /**
   * Parse mayacli `-j` output into [{type,name,obj}]. The `-j` form is the mayagui
   * `V()/M()` JS-callback program (NOT JSON): `V("<type>","<name>",'<js-object-literal>')`.
   * Bodies use unquoted keys + double-quoted strings and contain no single quotes, so we
   * extract each call by regex and eval the body as a JS object literal (same as index.cgi).
   */
  parseJ(output) {
    const items = [];
    const re = /[A-Za-z]\w*\("([^"]*)","([^"]*)"(?:,'([^']*)')?\)/g;
    let m;
    while ((m = re.exec(output || "")) !== null) {
      let obj = {};
      if (m[3]) {
        try {
          obj = eval("(" + m[3] + ")"); // trusted: our own mayacli output
        } catch (e) {
          obj = {};
        }
      }
      items.push({ type: m[1], name: m[2], obj });
    }
    return items;
  }

  /** clusterid (cid) of a zpool via `-j show volume <pool>` (vtype zpool=14). */
  async getPoolClusterid(pool) {
    const r = await this.exec(["-j", "show", "volume", pool]);
    if (r.code !== 0) {
      const e = new Error(
        `mayacli -j show volume ${pool} failed (rc=${r.code}): ${(r.stderr || r.stdout).trim()}`
      );
      e.code = r.code;
      throw e;
    }
    const z = this.parseJ(r.stdout).find((i) => i.name === pool || i.obj.l === pool);
    if (!z || z.obj.cid == null) {
      throw new Error(`pool '${pool}' not found (or no clusterid) via mayacli show volume`);
    }
    return Number(z.obj.cid);
  }

  /**
   * Failover map { "<mapid>": "<virtip>" } from `-j show failover`. mapid == a node's
   * clusterid (== the zpool cid), virtip == that node's data VIP. Empty on a single-node /
   * no-HA cluster (then the caller falls back to the mgmt host as the server).
   */
  async showFailover() {
    const r = await this.exec(["-j", "show", "failover"]);
    const byMapid = {};
    if (r.code === 0) {
      const fo = this.parseJ(r.stdout).find((i) => i.type === "failoverinfo");
      const ns = fo && Array.isArray(fo.obj.nodestat) ? fo.obj.nodestat : [];
      for (const n of ns) {
        if (n.mapid != null && n.virtip) byMapid[String(n.mapid)] = n.virtip;
      }
    }
    return { byMapid };
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
    // options value carries literal surrounding double-quotes (matches cluster_setup2.sh
    // `options=\""$nfs_options"\"`); spawn passes argv directly, no shell, so no escaping needed.
    if (a.options) args.push(Mayacli.opt(`"${a.options}"`));
    return this.execOk(args);
  }

  async bindMapping(vol) {
    return this.execOk(["bind", "mapping", vol]);
  }

  async unbindMapping(vol) {
    // an absent / already-unbound mapping exits EINVAL(22) (verified live), or
    // ENOENT -- treat both as idempotent success for the DeleteVolume flow.
    return this.execOk(["unbind", "mapping", vol], {
      ignoreCodes: [ERRNO.ENOENT, ERRNO.EINVAL],
    });
  }

  async deleteMapping(vol) {
    return this.execOk(["delete", "mapping", vol], { ignoreCodes: [ERRNO.ENOENT] });
  }

  // ---- snapshots -------------------------------------------------------------
  /** create snapshot <name> snapshotof=<vol> [size=<n>G] */
  async createSnapshot(a) {
    const args = ["create", "snapshot", a.name, `snapshotof=${a.vol}`];
    if (a.sizeG) args.push(`size=${a.sizeG}G`);
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
