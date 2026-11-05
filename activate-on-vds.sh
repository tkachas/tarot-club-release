#!/usr/bin/env bash
set -euo pipefail

app_dir=/home/deploy/tarot-club
caddyfile=/etc/caddy/Caddyfile
if [[ "$(id -u)" -ne 0 ]]; then
  echo 'Запустите этот файл от root' >&2
  exit 1
fi
test -x /home/deploy/.local/node24/bin/node
test -f "$app_dir/server.mjs"
test -f "$app_dir/tarot-club.service"
test -f "$caddyfile"
command -v python3 >/dev/null

install -m 0644 "$app_dir/tarot-club.service" /etc/systemd/system/tarot-club.service
systemctl daemon-reload
systemctl enable --now tarot-club.service
for attempt in {1..20}; do
  if curl --noproxy '*' -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl --noproxy '*' -fsS http://127.0.0.1:3000/api/health

backup="$caddyfile.before-tarot-$(date +%Y%m%d-%H%M%S)"
cp -a "$caddyfile" "$backup"

python3 - "$caddyfile" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
if text.count('bimbochka.ru {') != 1:
    raise SystemExit('Ожидался один блок bimbochka.ru; Caddyfile не изменён')
old = '  root /srv/www/bimbochka.ru\n  file_server'
new = '  reverse_proxy 127.0.0.1:3000 {\n    header_up -Authorization\n  }'
if old not in text:
    if new in text:
        raise SystemExit(0)
    raise SystemExit('Конфигурация Caddy изменилась; Caddyfile не изменён')
path.write_text(text.replace(old, new, 1))
PY

if ! caddy validate --config "$caddyfile"; then
  cp -a "$backup" "$caddyfile"
  echo "Проверка Caddy не прошла. Восстановлена копия $backup" >&2
  exit 1
fi
if ! systemctl reload caddy; then
  cp -a "$backup" "$caddyfile"
  systemctl reload caddy || true
  echo "Перезагрузка Caddy не прошла. Восстановлена копия $backup" >&2
  exit 1
fi
echo "Caddy переключён на приложение. Резервная копия: $backup"
echo 'Проверка без логина должна вернуть 401:'
status="$(curl --noproxy '*' --resolve bimbochka.ru:443:127.0.0.1 -sS -o /dev/null -w '%{http_code}' https://bimbochka.ru/)"
echo "$status"
if [[ "$status" != 401 ]]; then
  echo 'Проверьте домен, TLS и basic_auth в Caddy' >&2
  exit 1
fi
