#!/usr/bin/env bash
# Сборка архива для Яндекс Игр.
#
# Правила площадки: ZIP, в корне index.html, содержимое до сжатия ≤ 100 МБ,
# в именах файлов нет пробелов и кириллицы. Игра хостится у Яндекса,
# поэтому в архив идёт то же самое, что на GitHub Pages, минус служебное.
set -euo pipefail
cd "$(dirname "$0")"

OUT=dist/shf-yandex.zip
mkdir -p dist
rm -f "$OUT"

zip -r -q "$OUT" index.html manifest.webmanifest css js assets \
  -x 'js/vendor/PATCHES.md'

# контроль: лимит площадки — 100 МБ до сжатия
BYTES=$(unzip -l "$OUT" | tail -1 | awk '{print $1}')
echo "Файлов: $(unzip -l "$OUT" | tail -1 | awk '{print $2}'), до сжатия: $((BYTES/1024/1024)) МБ (лимит 100)"
ls -lh "$OUT"
