#!/bin/sh
# sysinit: läuft einmalig vor allen respawn-Services
set -e
log() { echo "[setup] $*" >/dev/kmsg 2>/dev/null || echo "[setup] $*"; }

# Filesystems (busybox init mountet /proc und /sys bereits)
mount -t devtmpfs  dev      /dev     2>/dev/null || true
mount -t devpts    devpts   /dev/pts 2>/dev/null || true
mount -t tmpfs     tmpfs    /dev/shm 2>/dev/null || true
mount -t tmpfs     tmpfs    /run
mkdir -p /run/containerd /run/cni /run/svc-logs

log "Filesystems bereit"

# State-Disk (/dev/vdb → /data)
mkdir -p /data
if ! blkid /dev/vdb 2>/dev/null | grep -q ext4; then
    log "Formatiere State-Disk /dev/vdb..."
    mkfs.ext4 -q -L state /dev/vdb
fi
mount /dev/vdb /data
mkdir -p /data/{containerd,docker,ssh,images}

log "State-Disk gemountet"

# SSH-Keys (erster Boot)
[ ! -f /data/ssh/authorized_keys ] && {
    cp /etc/authorized_keys /data/ssh/authorized_keys
    chmod 600 /data/ssh/authorized_keys
}
[ ! -f /data/ssh/ssh_host_ed25519_key ] && {
    log "Generiere SSH Host-Keys..."
    ssh-keygen -q -t ed25519 -N '' -f /data/ssh/ssh_host_ed25519_key
    ssh-keygen -q -t rsa    -b 4096 -N '' -f /data/ssh/ssh_host_rsa_key
}

log "SSH-Keys bereit"

# Netzwerk
ip link set lo up 2>/dev/null || true
for iface in eth0 net0 ens3 ens192; do
    ip link set "$iface" up 2>/dev/null || continue
    udhcpc -i "$iface" -q -t 5 -n 2>/dev/null && { log "DHCP ok ($iface)"; break; }
done

log "Setup abgeschlossen – containerd startet"
