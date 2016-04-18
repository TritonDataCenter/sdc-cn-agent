/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

int
mknod(const char *path, mode_t mode, dev_t dev)
{
        int tmpfd;

        if ((tmpfd = open(path, O_CREAT | O_EXCL, mode)) == -1) {
                return (-1);
        }

        (void) close(tmpfd);

        return (0);
}

int
mknodat(int fd, const char *path, mode_t mode, dev_t dev)
{
        int tmpfd;

        if ((tmpfd = openat(fd, path, O_CREAT | O_EXCL, mode)) == -1) {
                return (-1);
        }

        (void) close(tmpfd);

        return (0);
}

int
_mknod()
{
        return (0);
}

int
_xmknod(int version, const char *path, mode_t mode, dev_t dev)
{
        return (0);
}
