#!/bin/bash

set -o xtrace
DIR=`dirname $0`
ROOT=$(cd `dirname $0`/.. && pwd)

export PREFIX=$npm_config_prefix
export ETC_DIR=$npm_config_etc
export SMF_DIR=$npm_config_smfdir
export VERSION=$npm_package_version
export ENABLED=false

if [[ $CONFIG_die_rabbit_die == "true" ]]; then
    export ENABLED=true
fi

subfile () {
  IN=$1
  OUT=$2
  sed -e "s#@@PREFIX@@#$PREFIX#g" \
      -e "s/@@VERSION@@/$VERSION/g" \
      -e "s#@@ROOT@@#$ROOT#g" \
      $IN > $OUT
}

subfile "$ROOT/smf/method/cn-agent.in" "$ROOT/smf/method/cn-agent"
subfile "$ROOT/smf/manifests/cn-agent.xml.in" "$SMF_DIR/cn-agent.xml"
chmod +x "$ROOT/smf/method/cn-agent"
svccfg import $SMF_DIR/cn-agent.xml
