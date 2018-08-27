#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

if [[ "${SDC_AGENT_SKIP_LIFECYCLE:-no}" = "yes" ]]; then
    printf 'Running during package build; skipping lifecycle script.\n' >&2
    exit 0
fi

# Refuse to install on a platform less than the supported min-platform.
MIN_PLATFORM=20151126T062538Z
if [[ $(uname -v | cut -d '_' -f2) < $MIN_PLATFORM ]]; then
    echo "FATAL: min-platform for this agent is $MIN_PLATFORM" >&2
    exit 2
fi

exit 0
