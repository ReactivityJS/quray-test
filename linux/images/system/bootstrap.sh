#!/bin/sh
# bootstrap.sh – startet System-Container beim ersten Boot oder nach Datenverlust
# Idempotent: laufende / existierende Container werden nicht angefasst
. /usr/local/lib/init/bootstrap-utils.sh

# Alle svc-def-Skripte ausführen (je eines pro Service)
for def in /usr/local/lib/svc-def/*.sh; do
    [ -f "$def" ] || continue
    log "Starte Service-Definition: $(basename "$def" .sh)"
    sh "$def" || true
done

log "Bootstrap abgeschlossen"
