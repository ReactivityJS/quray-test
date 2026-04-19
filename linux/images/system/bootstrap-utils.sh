#!/bin/sh
# Gemeinsame Hilfsfunktionen für bootstrap.sh und svc-def/*.sh

log() { echo "[bootstrap] $*"; }

# Image sicherstellen: Store → Pull → State-Disk-TAR → initrd-TAR
img_ensure() {
    local name="$1" image="$2"
    nerdctl image inspect "$image" >/dev/null 2>&1 && return 0
    log "Image $image wird geladen..."
    nerdctl pull "$image"                         2>/dev/null && return 0
    nerdctl load -i "/data/images/${name}.tar"    2>/dev/null && return 0
    nerdctl load -i "/bundles/${name}.tar"        2>/dev/null && return 0
    log "WARNUNG: $image nicht verfügbar – $name wird übersprungen"
    return 1
}

# Container starten, falls noch nicht vorhanden (idempotent)
# Bestehende Container werden vom containerd restart-manager verwaltet
ctr_run() {
    local name="$1"; shift
    if nerdctl inspect "$name" >/dev/null 2>&1; then
        log "$name existiert bereits (restart-manager übernimmt)"
        return 0
    fi
    log "Erstelle Container $name..."
    nerdctl run -d --restart=unless-stopped "$@" \
        || log "WARNUNG: $name konnte nicht gestartet werden"
}
