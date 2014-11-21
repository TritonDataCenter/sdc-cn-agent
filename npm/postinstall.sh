#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

set -o xtrace
DIR=`dirname $0`
ROOT=$(cd `dirname $0`/.. && pwd)

. /lib/sdc/config.sh

load_sdc_config

export PREFIX=$npm_config_prefix
export ETC_DIR=$npm_config_etc
export SMF_DIR=$npm_config_smfdir
export VERSION=$npm_package_version
export ENABLED=false

if [[ $CONFIG_no_rabbit == "true" ]]; then
    export ENABLED=true
fi

subfile () {
  IN=$1
  OUT=$2
  sed -e "s#@@PREFIX@@#$PREFIX#g" \
      -e "s/@@VERSION@@/$VERSION/g" \
      -e "s#@@ROOT@@#$ROOT#g" \
      -e "s/@@ENABLED@@/$ENABLED/g" \
      $IN > $OUT
}

subfile "$ROOT/smf/method/cn-agent.in" "$ROOT/smf/method/cn-agent"
subfile "$ROOT/smf/manifests/cn-agent.xml.in" "$SMF_DIR/cn-agent.xml"
chmod +x "$ROOT/smf/method/cn-agent"
svccfg import $SMF_DIR/cn-agent.xml
