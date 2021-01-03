#!/bin/bash

set -e

cd "$( dirname "${BASH_SOURCE[0]}" )"

source ./credentials.sh

mkdir -p addon/live addon/dynamic

node src/addon.js

cd addon
rm -f OribosExchange.zip
zip -r OribosExchange.zip OribosExchange
advzip -z -4 OribosExchange.zip
mv -v OribosExchange.zip live/

cd ..
node src/addon.curse.js
