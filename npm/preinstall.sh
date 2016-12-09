#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2016 Joyent, Inc.
#

if [[ "${SDC_AGENT_SKIP_LIFECYCLE:-no}" = "yes" ]]; then
    printf 'Running during package build; skipping lifecycle script.\n' >&2
    exit 0
fi

# min-platform is now 20141030T081701Z, so refuse to install if someone is
# trying to load on something older.
if [[ $(uname -v | cut -d '_' -f2 | tr -d '[A-Z]') -lt 20141030081701 ]]; then
    echo "FATAL: min-platform for this agent is 20141030T081701Z" >&2
    exit 2
fi

exit 0
