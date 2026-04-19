# Service-Images als Build-Stages (rootfs wird via COPY --from extrahiert)
FROM local/sshd:1.0        AS sshd
FROM local/ntp:1.0         AS ntp
FROM local/vmware:1.0      AS vmware
FROM local/firewall:1.0    AS firewall
FROM local/user-docker:1.0 AS user-docker

# System-Image
FROM alpine:3.19

RUN apk add --no-cache \
    busybox-extras \
    e2fsprogs \
    iproute2 \
    openssh-keygen \
    util-linux \
    blkid

# PID-1 init-Skript
COPY init /init
RUN chmod +x /init

# Service-Manager
COPY svc /usr/local/bin/svc
RUN chmod +x /usr/local/bin/svc

# Service-Rootfs vorab extrahieren (OCI-Bundle rootfs/)
COPY --from=sshd        / /bundles/sshd/rootfs/
COPY --from=ntp         / /bundles/ntp/rootfs/
COPY --from=vmware      / /bundles/vmware/rootfs/
COPY --from=firewall    / /bundles/firewall/rootfs/
COPY --from=user-docker / /bundles/user-docker/rootfs/

# OCI-Runtime-Configs (config.json pro Bundle)
COPY configs/sshd/config.json         /bundles/sshd/config.json
COPY configs/ntp/config.json          /bundles/ntp/config.json
COPY configs/vmware/config.json       /bundles/vmware/config.json
COPY configs/firewall/config.json     /bundles/firewall/config.json
COPY configs/user-docker/config.json  /bundles/user-docker/config.json

# Initialer SSH authorized_keys (wird beim ersten Boot nach /data/ssh/ kopiert)
COPY authorized_keys /etc/authorized_keys
