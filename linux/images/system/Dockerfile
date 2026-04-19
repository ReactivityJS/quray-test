# nerdctl-Binary aus offiziellem Release holen
FROM alpine:3.19 AS nerdctl-fetch
ARG NERDCTL_VERSION=1.7.6
RUN apk add --no-cache curl && \
    curl -fsSL "https://github.com/containerd/nerdctl/releases/download/v${NERDCTL_VERSION}/nerdctl-${NERDCTL_VERSION}-linux-amd64.tar.gz" \
    | tar xz -C /usr/local/bin nerdctl

# System-Image (schlanke initrd-Basis)
FROM alpine:3.19

RUN apk add --no-cache \
    busybox-extras \
    containerd \
    crun \
    e2fsprogs \
    iproute2 \
    openssh-keygen \
    util-linux && \
    # crun als runc-Alias → containerd nutzt crun transparent
    ln -sf /usr/bin/crun /usr/bin/runc && \
    # /init → busybox init (PID 1 für LinuxKit)
    ln -sf /sbin/init /init && \
    mkdir -p /etc/containerd /etc/inittab.d \
             /usr/local/lib/{init,svc-run,svc-def} \
             /bundles

# nerdctl-Binary
COPY --from=nerdctl-fetch /usr/local/bin/nerdctl /usr/local/bin/nerdctl

# containerd-Konfiguration
COPY containerd.toml /etc/containerd/config.toml

# busybox inittab (ein respawn: containerd)
COPY inittab      /etc/inittab
COPY inittab.d/   /etc/inittab.d/

# Init-Skripte
COPY setup.sh           /usr/local/lib/init/setup.sh
COPY shutdown.sh        /usr/local/lib/init/shutdown.sh
COPY bootstrap-utils.sh /usr/local/lib/init/bootstrap-utils.sh
COPY bootstrap.sh       /usr/local/lib/init/bootstrap.sh
RUN chmod +x /usr/local/lib/init/*.sh

# containerd-Starter (svc-run/containerd)
COPY svc-run/containerd /usr/local/lib/svc-run/containerd
RUN chmod +x /usr/local/lib/svc-run/containerd

# Service-Definitionen
COPY svc-def/ /usr/local/lib/svc-def/
RUN chmod +x /usr/local/lib/svc-def/*.sh

# svc-Wrapper
COPY svc /usr/local/bin/svc
RUN chmod +x /usr/local/bin/svc

# Initialer SSH authorized_keys (→ /data/ssh/ beim ersten Boot)
COPY authorized_keys /etc/authorized_keys
