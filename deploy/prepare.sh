#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run on the new Ubuntu server as root.' >&2; exit 1; fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077
install -d -m 700 config data data/gmpay
install -d -m 700 -o 1000 -g 1000 ../web/data
[[ -e .env ]] || cp deployment.env.example .env
[[ -e config/portal.env ]] || cp portal.env.example config/portal.env
[[ -e config/payment-catalog.json ]] || cp ../web/config/payment-catalog.confirmed.json config/payment-catalog.json
[[ -e config/supabase-ca.crt ]] || cp ../web/config/supabase-ca.crt config/supabase-ca.crt
[[ -e config/Caddyfile ]] || cp Caddyfile.setup config/Caddyfile
# Runtime Node uses uid 1000. Caddy runs as root and can read the same mount.
chown 1000:1000 .env config config/portal.env config/payment-catalog.json config/supabase-ca.crt
chmod 700 config
chmod 600 .env config/portal.env config/payment-catalog.json config/Caddyfile
echo 'Prepared without overwriting existing config. Edit .env and config/portal.env; payments remain disabled.'
