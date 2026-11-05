# Бимбо карты

Совместная колода и журнал гаданий для небольшого круга людей. Исходная HTML-страница преобразована в приложение с общей базой SQLite. В колоде 78 карт. Участники видят общие трактовки и гадания; изменения с другого устройства появляются в течение примерно 5 секунд. При одновременном редактировании одного поля приложение сообщает о конфликте и предлагает выбрать версию.

## Запуск на VDS с Caddy

Для текущего VDS с Ubuntu 26.04 и уже работающим Caddy предусмотрен запуск от пользователя `deploy` через systemd. Node.js 24 устанавливается в домашний каталог пользователя, без изменения системных пакетов. Приложение слушает только `127.0.0.1:3000`, а Caddy защищает весь домен `bimbochka.ru` общим логином и паролем.

Загрузите архив `tarot-club-release.tar.gz` в `/home/deploy`, затем войдите по SSH под `deploy` и выполните:

```bash
mkdir -p /home/deploy/tarot-club
tar -xzf /home/deploy/tarot-club-release.tar.gz -C /home/deploy/tarot-club
cd /home/deploy/tarot-club
mkdir -p data
chmod 700 data
bash install-node24.sh
```

Проверьте [activate-on-vds.sh](activate-on-vds.sh) и [tarot-club.service](tarot-club.service). В уже открытой root-консоли VDS выполните:

```bash
bash /home/deploy/tarot-club/activate-on-vds.sh
```

Скрипт создаёт службу, сохраняет копию текущего Caddyfile, затем заменяет выдачу файлов для `bimbochka.ru` на проксирование приложения. Существующий `basic_auth` остаётся. Скрипт проверяет конфигурацию Caddy перед перезагрузкой и ожидает ответ `401` без логина. Старые файлы сайта в `/srv/www/bimbochka.ru` не удаляются.

Для проверки:

```bash
systemctl status tarot-club --no-pager
curl -f http://127.0.0.1:3000/api/health
curl -I https://bimbochka.ru
```

Для запроса без логина ожидается `401 Unauthorized`. В браузере появится окно входа; после него откроется приложение. Порт 3000 не нужно разрешать во внешнем файрволе.

**Общий логин Caddy даёт всем участникам одинаковые права** на чтение, изменение и удаление записей. Поле «Ваше имя» служит подписью трактовок, а не отдельной учётной записью.

## Данные и резервная копия

База лежит в `data/tarot.sqlite`; при работающем приложении SQLite может также создавать `-wal` и `-shm`. Для надёжной копии остановите запись на несколько секунд и сохраните весь каталог:

```bash
cd /home/deploy/tarot-club
sudo systemctl stop tarot-club
sudo tar -czf "$HOME/tarot-backup-$(date +%F-%H%M).tar.gz" data
sudo systemctl start tarot-club
```

Храните копию вне VDS. Чтобы восстановить её, остановите приложение, распакуйте каталог `data` из архива в `/home/deploy/tarot-club`, проверьте владельца `deploy` и запустите `sudo systemctl start tarot-club`.

## Обновление и диагностика

Замените файлы приложения, не затрагивая `data/`, затем:

```bash
cd /home/deploy/tarot-club
sudo systemctl restart tarot-club
sudo journalctl -u tarot-club -n 100 --no-pager
curl -f http://127.0.0.1:3000/api/health
sudo journalctl -u caddy -n 100 --no-pager
```

Для отдельного сервера с Docker доступны [Dockerfile](Dockerfile) и [compose.yaml](compose.yaml). В этом варианте создайте `data` с владельцем UID 1000, запустите `sudo docker compose up -d --build` и вручную добавьте в Caddy конфигурацию из [Caddyfile.example](Caddyfile.example).

## Локальная проверка без Docker

Нужен Node.js 22.13+ с модулем `node:sqlite` или Node.js 24+:

```bash
node --test test/server.test.mjs
node server.mjs
```

После запуска откройте `http://127.0.0.1:3000`. Данные сохраняются в `data/`. Внешнюю публикацию без Caddy и авторизации делать не следует.
