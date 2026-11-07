#!/usr/bin/env bash
# Cold backup: brief payment downtime; run during a maintenance window.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root on the server.' >&2; exit 1; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077
install -d -m 700 /var/backups/mofacloak
previous=()
running=$(docker compose ps --services --status running)
while IFS= read -r service; do
  case "$service" in portal|epusdt) previous+=("$service");; esac
done <<< "$running"
restart_previous() { if ((${#previous[@]})); then docker compose start "${previous[@]}"; fi; }
trap restart_previous EXIT
docker compose stop portal epusdt
archive="/var/backups/mofacloak/$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
tar -C .. -czf "$archive.partial" web/data deploy/data/gmpay deploy/config deploy/.env deploy/compose.yaml
tar -tzf "$archive.partial" >/dev/null
mv -- "$archive.partial" "$archive"
chmod 600 "$archive"
sha256sum "$archive" > "$archive.sha256"
echo "Backup: $archive (contains credentials; copy to private offline storage). No old backup deleted."
