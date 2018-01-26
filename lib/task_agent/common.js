/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */


// generate random 4 byte hex strings
function genId() {
    return Math.floor(Math.random() * 0xffffffff).toString(16);
}


module.exports = {
    genId: genId
};
