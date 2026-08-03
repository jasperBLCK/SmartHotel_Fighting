#!/usr/bin/env bash
# Сборка архива для Яндекс Игр.
#
# Правила площадки: ZIP, в корне index.html, содержимое до сжатия ≤ 100 МБ,
# в именах файлов нет пробелов и кириллицы. Игра хостится у Яндекса,
# поэтому в архив идёт то же самое, что на GitHub Pages, минус служебное.
#
# Заодно скрипт выписывает dist/hosts.txt — домены, которые нужно
# задекларировать в консоли разработчика. Он собирается из js/net-config.js,
# а не пишется руками: CSP Яндекса режет всё незадекларированное, и разъехаться
# этим двум спискам нельзя.
set -euo pipefail
cd "$(dirname "$0")"

OUT=dist/shf-yandex.zip
mkdir -p dist
rm -f "$OUT"

# --- проверки до сборки: дешевле поймать здесь, чем на модерации ---
[ -f index.html ] || { echo "нет index.html в корне"; exit 1; }

BAD=$(find index.html manifest.webmanifest css js assets -print | LC_ALL=C grep -P '[ \x80-\xff]' || true)
if [ -n "$BAD" ]; then
  echo "недопустимые имена файлов (пробелы или кириллица):"
  echo "$BAD"
  exit 1
fi

zip -r -q "$OUT" index.html manifest.webmanifest css js assets \
  -x 'js/vendor/PATCHES.md'

# --- домены для декларации в консоли ---
# Только wss: правила площадки других схем в декларации не принимают, а
# stun:/turn: CSP браузера и не проверяет — они идут мимо fetch и WebSocket.
# Комментарии выкидываем: там лежат примеры вроде turn:my-server.ru.
CODE=$(sed '/\/\*/,/\*\//d' js/net-config.js | grep -vP "^\s*//")

echo "$CODE" | grep -oP "(?<=')wss://[^']+(?=')" \
  | sed -E 's#^wss://##; s#/.*$##' | sort -u > dist/hosts.txt

ICE=$(echo "$CODE" | grep -oP "(stun|turn)s?:[^'\"]+" | sort -u | tr '\n' ' ')

# --- контроль: лимит площадки — 100 МБ до сжатия ---
BYTES=$(unzip -l "$OUT" | tail -1 | awk '{print $1}')
FILES=$(unzip -l "$OUT" | tail -1 | awk '{print $2}')
if [ "$BYTES" -gt $((100 * 1024 * 1024)) ]; then
  echo "архив больше 100 МБ до сжатия — площадка не примет"
  exit 1
fi

echo "Файлов: $FILES, до сжатия: $((BYTES / 1024 / 1024)) МБ (лимит 100)"
echo "Хостов для декларации: $(wc -l < dist/hosts.txt) → dist/hosts.txt"
echo "STUN/TURN (не декларируются, см. docs/YANDEX.md): $ICE"
ls -lh "$OUT"
