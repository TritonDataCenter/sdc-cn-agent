#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2015 Joyent, Inc.
#

if [[ "${SDC_AGENT_SKIP_LIFECYCLE:-no}" = "yes" ]]; then
    printf 'Running during package build; skipping lifecycle script.\n' >&2
    exit 0
fi

ROOT="$(cd `dirname $0`/../ 2>/dev/null && pwd)"

. "${ROOT}/npm/lib/error_handler.sh"
. "${ROOT}/npm/lib/trace_logger.sh"

set -o nounset

export SMF_DIR="${npm_config_smfdir}"

AGENT="${npm_package_name}"

if svcs "${AGENT}"; then
    svcadm disable -s "${AGENT}"
    svccfg delete "${AGENT}"
fi

rm -f "${SMF_DIR}/${AGENT}.xml"
