#!/bin/bash

cd "$( dirname "${BASH_SOURCE[0]}" )"

JSON=public-json

TMPFILE=$(mktemp)
trap "rm -f $TMPFILE" EXIT

gzbr () {
  local fn="$1"
  echo Compressing $fn

  cat $fn | gzip --best > ${fn}.gztemp
  touch -r $fn ${fn}.gztemp
  mv ${fn}.gztemp ${fn}.gz
  
  brotli -o ${fn}.brtemp $fn
  mv ${fn}.brtemp ${fn}.br
}

date

cat items.all.json | jq -c $(sed -e 's/\[/{/g' -e 's/\]/}/g' ids.bound.json) > $TMPFILE
diff -q $TMPFILE $JSON/items.bound.json
if [ $? -ne 0 ]; then
  rm $JSON/items.bound.json $JSON/items.bound.json.gz $JSON/items.bound.json.br
  cp $TMPFILE $JSON/items.bound.json
  chmod +r $JSON/items.bound.json
  gzbr $JSON/items.bound.json
fi

for fn in names.bound.*.json; do
  cat $fn | jq -c $(sed -e 's/\[/{/g' -e 's/\]/}/g' ids.bound.json) > $TMPFILE
  diff -q $TMPFILE $JSON/$fn
  if [ $? -ne 0 ]; then
    rm $JSON/${fn} $JSON/${fn}.gz $JSON/${fn}.br
    cp $TMPFILE $JSON/${fn}
    chmod +r $JSON/${fn}
    gzbr $JSON/${fn}
  fi
done

