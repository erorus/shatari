#!/bin/bash

set -e

cd "$( dirname "${BASH_SOURCE[0]}" )"

source ./credentials.sh

wago_upload () {
  addonVers=$(unzip -p addon/live/OribosExchange.zip OribosExchange/OribosExchange.toc | grep '## Version: ' | awk '{print $3}')
  gameVers=$(curl -s 'https://ribbit.everynothing.net/products/wow/versions' | grep '^eu|' | awk -F '|' '{print $6}' | awk -F . '{print $1 "." $2 "." $3}')
  today=$(date '+%A, %B %-d, %Y')
  changelog="Automatic data update for $today"
  json=$(jq --arg addonVers "$addonVers" --arg patch "$gameVers" --arg changelog "$changelog" '. | .label=$addonVers | .changelog=$changelog | .supported_retail_patch=$patch' <<< '{"stability":"stable"}')

  echo "Uploading to wago... "
  curl -F "metadata=$json" -F 'file=@addon/live/OribosExchange.zip' -H "authorization: Bearer $WAGO_API_TOKEN" -H 'accept: application/json' "https://addons.wago.io/api/projects/$WAGO_PROJECT_ID/version"
  echo;
}

mkdir -p addon/live addon/dynamic

if [ "$1" != "" ]; then
  echo "Will not upload zip to addon sites!"
fi

node --max-old-space-size=5120 src/addon.js

cd addon
rm -f OribosExchange.zip
zip -r OribosExchange.zip OribosExchange
advzip -z -4 OribosExchange.zip
mv -v OribosExchange.zip live/

if [ "$1" != "" ]; then
  exit
fi

cd ..
node src/addon.curse.js

wago_upload
