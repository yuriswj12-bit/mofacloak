#!/usr/bin/env bash
# Import an exported portal.sqlite into an EMPTY production data directory only.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root on the VPS.' >&2; exit 1; }
[[ $# -eq 1 ]] || { echo 'Usage: bash import-portal.sh /absolute/path/to/snapshot' >&2; exit 1; }
snapshot=$(realpath -- "$1")
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ -f "$snapshot/portal.sqlite" && -f "$snapshot/portal.sqlite.sha256" && -f "$snapshot/snapshot.json" ]] || { echo 'Incomplete snapshot.' >&2; exit 1; }
read -r digest filename < "$snapshot/portal.sqlite.sha256"
[[ $digest =~ ^[a-f0-9]{64}$ && $filename == portal.sqlite ]] || { echo 'Invalid checksum file.' >&2; exit 1; }
actual=$(sha256sum -- "$snapshot/portal.sqlite")
[[ ${actual:0:64} == "$digest" ]] || { echo 'Snapshot checksum mismatch.' >&2; exit 1; }
target=../web/data/portal.sqlite
[[ -d ../web/data ]] || { echo 'Run prepare.sh first.' >&2; exit 1; }
for file in "$target" "$target-wal" "$target-shm"; do
  [[ ! -e "$file" && ! -L "$file" ]] || { echo 'Existing database found. No import performed; use a new deployment directory.' >&2; exit 1; }
done
umask 077
(set -o noclobber; cat -- "$snapshot/portal.sqlite" > "$target")
chown 1000:1000 "$target"
chmod 600 "$target"
echo 'Imported verified portal snapshot into empty data directory. No source file moved; no existing database overwritten.'
