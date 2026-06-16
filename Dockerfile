# ZettaLane CSI image — Rocky Linux 9 (el9) base.
#
# Preferred base: mayacli is BUILT on el9 (GLIBC_2.34, /lib64), and the MayaNAS
# storage node is el9 — so a Rocky 9 image is a NATIVE ABI match (no debian
# forward-compat assumption) and shares one lib/tooling stack with the server.
# Swap `rockylinux:9-minimal` for `redhat/ubi9-minimal` if you want Red Hat UBI.
#
# Build context = the staged tree (staging/zettalane-csi). Example:
#   docker build -f Dockerfile -t zettalane-csi:el9 staging/zettalane-csi
# (build-staging.sh stages the selected base Dockerfile as ./Dockerfile)

######################
# nodejs build stage
######################
FROM rockylinux:9-minimal AS build

ENV NODE_VERSION=v20.19.0
ENV NODE_ENV=production
ENV LANG=C.UTF-8

# tools needed by node-installer.sh (download + extract node from nodejs.org)
RUN microdnf install -y wget tar xz gzip ca-certificates \
  && microdnf clean all

ADD docker/node-installer.sh /usr/local/sbin
RUN chmod +x /usr/local/sbin/node-installer.sh && node-installer.sh
ENV PATH=/usr/local/lib/nodejs/bin:$PATH

WORKDIR /app
# install deps first for layer caching; no native modules -> no mirror env needed
COPY package*.json ./
RUN npm install --only=production --no-audit --no-fund
COPY . .
RUN rm -rf docker packaging vendor


######################
# final image
######################
FROM rockylinux:9-minimal

ARG VERSION=dev
# Artifact identity only. This image is an el9 Linux runtime carrying the CSI
# payload + (proprietary) mayacli — its license is NOT a single license and NOT
# MIT; the per-component picture lives in the bundled LICENSE/NOTICE, not a label.
LABEL org.opencontainers.image.title="zettalane-csi" \
      org.opencontainers.image.vendor="ZettaLane Systems LLC" \
      org.opencontainers.image.version="${VERSION}"

ENV DEMOCRATIC_CSI_IS_CONTAINER=true
ENV NODE_ENV=production
ENV LANG=C.UTF-8

# node binary from the build stage
COPY --from=build /usr/local/lib/nodejs/bin/node /usr/local/bin/node

# runtime + node-attach tooling (nfs + nvme-of + mkfs/mount) and mayacli's libs.
# On el9 these are the EXACT lib versions mayacli was linked against:
#   libuuid -> libuuid.so.1 | openssl-libs -> libssl.so.3 + libcrypto.so.3
#   libtirpc -> libtirpc.so.3 | krb5-libs -> libgssapi_krb5/krb5/... (tirpc dep)
# install_weak_deps=0 drops recommended-only bloat (fonts, cracklib-dicts, gnupg2,
# langpack extras, etc.); tsflags=nodocs skips man/doc. Connectors kept: nfs, nvme-of,
# iscsi, smb(cifs). Dropped: fuse3 (only the oneclient/objectivefs FUSE connectors,
# which we never emit). After install, strip the dnf history + cache (microdnf clean
# all leaves /var/lib/dnf/history.* + the WAL).
#
# Block protocols (iscsi + nvme-of) carry NO client tooling or identity in the image:
# the node plugin bridges to the HOST via wrapper scripts (docker/iscsiadm, docker/nvme),
# so iscsiadm/nvme run on the host with the node's real identity (initiatorname.iscsi /
# /etc/nvme/hostnqn). Hence neither iscsi-initiator-utils nor nvme-cli is installed --
# which also sidesteps iscsi-initiator-utils's %post `systemctl` failing the build.
RUN microdnf install -y --setopt=install_weak_deps=0 --setopt=tsflags=nodocs \
      glibc-minimal-langpack \
      nfs-utils \
      xfsprogs e2fsprogs util-linux gdisk cloud-utils-growpart \
      cifs-utils socat rsync procps-ng \
      libuuid openssl-libs libtirpc krb5-libs zlib \
  && microdnf clean all \
  && rm -rf /var/lib/dnf/history.* /var/cache/dnf /var/log/dnf* /var/log/hawkey.log

# host-command wrappers -> run the host's iscsiadm / nvme (chroot /host by default;
# nsenter alternative for immutable distros). Host node must have open-iscsi+iscsid
# (iscsi) and nvme-cli (nvme-of) installed; both supply the per-node client identity.
ADD docker/iscsiadm /usr/local/sbin/iscsiadm
ADD docker/nvme     /usr/local/sbin/nvme
RUN chmod +x /usr/local/sbin/iscsiadm /usr/local/sbin/nvme

# bundle mayacli (controller calls it; talks RPC to remote configd).
# build-staging.sh stages the binary at vendor/mayacli. On el9 this is a native
# ABI match for the el9-built binary — no forward-compat reliance.
COPY vendor/mayacli /usr/local/bin/mayacli
RUN chmod +x /usr/local/bin/mayacli

# app payload (includes node_modules from the build stage)
COPY --from=build /app /home/csi/app
WORKDIR /home/csi/app

# mayacli refuses to run as non-root, so we deliberately stay root (no USER).
EXPOSE 50051
ENTRYPOINT [ "bin/zettalane-csi" ]
