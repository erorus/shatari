#!/bin/bash

set -e

cd "$( dirname "${BASH_SOURCE[0]}" )"

source ./credentials.sh

node src/realmList.js

