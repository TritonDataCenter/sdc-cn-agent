#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

set -o xtrace
DIRNAME=$(cd `dirname $0`/.. && pwd)
cd $DIRNAME

rsync --recursive --partial -l ./{package.json,deps,bin,lib,test} /opt/smartdc/agents/lib/node_modules/cn-agent

if [[ -z "$NO_RESTART" ]]; then
    svcadm restart cn-agent
    svcadm clear cn-agent
fi
