#!/usr/sbin/dtrace -Cs

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Run this in the GZ and then create or start a zone with a docker attach.
 *
 * TODO:
 *
 *   descriptors close or processes exit, clean up variables
 *   figure out which descriptors are which in zoneadmd
 *   handle multiple zone starts at once? (mostly keep variables separate)
 *
 */

#pragma D option quiet
#pragma D option switchrate=100hz
#pragma D option bufsize=16m

#include <sys/socket.h>
#include <sys/sockio.h>
#include <sys/stropts.h>
#include <sys/termios.h>
#include <sys/zcons.h>
#include <sys/zfd.h>

#define ZONENAME_LEN 8

BEGIN
{
    dockerinit_pid = -1;
    docker_exec_pid = -1;
    docker_stdio_pid = -1;
    docker_stdio_port = -1;
    sdc_docker_pid = -1;

    /* there's probably a better way to do this */
    sig[1] = "SIGHUP";
    sig[2] = "SIGINT";
    sig[3] = "SIGQUIT";
    sig[4] = "SIGILL";
    sig[5] = "SIGTRAP";
    sig[6] = "SIGABRT";
    sig[7] = "SIGEMT";
    sig[8] = "SIGFPE";
    sig[9] = "SIGKILL";
    sig[10] = "SIGBUS";
    sig[11] = "SIGSEGV";
    sig[12] = "SIGSYS";
    sig[13] = "SIGPIPE";
    sig[14] = "SIGALRM";
    sig[15] = "SIGTERM";
    sig[16] = "SIGUSR1";
    sig[17] = "SIGUSR2";
    sig[18] = "SIGCHLD";
    sig[19] = "SIGPWR";
    sig[20] = "SIGWINCH";
    sig[21] = "SIGURG";
    sig[22] = "SIGPOLL";
    sig[23] = "SIGSTOP";
    sig[24] = "SIGTSTP";
    sig[25] = "SIGCONT";
    sig[26] = "SIGTTIN";
    sig[27] = "SIGTTOU";
    sig[28] = "SIGVTALRM";
    sig[29] = "SIGPROF";
    sig[30] = "SIGXCPU";
    sig[31] = "SIGXFSZ";
    sig[32] = "SIGWAITING";
    sig[33] = "SIGLWP";
    sig[34] = "SIGFREEZE";
    sig[35] = "SIGTHAW";
    sig[36] = "SIGCANCEL";
    sig[37] = "SIGLOST";
    sig[38] = "SIGXRES";
    sig[39] = "SIGJVM1";
    sig[40] = "SIGJVM2";
    sig[41] = "SIGINFO";

    ioctls[I_ANCHOR] = "I_ANCHOR";
    ioctls[I_FLUSH] = "I_FLUSH";
    ioctls[I_PUSH] = "I_PUSH";
    ioctls[I_SRDOPT] = "I_SRDOPT";
    ioctls[I_STR] = "I_STR";
    ioctls[I_SWROPT] = "I_SWROPT";

    ioctls[SIOCGLIFADDR] = "SIOCGLIFADDR";
    ioctls[SIOCGLIFCONF] = "SIOCGLIFCONF";
    ioctls[SIOCGLIFFLAGS] = "SIOCGLIFFLAGS";
    ioctls[SIOCGLIFNETMASK] = "SIOCGLIFNETMASK";
    ioctls[SIOCGLIFNUM] = "SIOCGLIFNUM";
    ioctls[SIOCGLIFZONE] = "SIOCGLIFZONE";
    ioctls[SIOCLIFADDIF] = "SIOCLIFADDIF";
    ioctls[SIOCLIFREMOVEIF] = "SIOCLIFREMOVEIF";
    ioctls[SIOCSLIFADDR] = "SIOCSLIFADDR";
    ioctls[SIOCSLIFFLAGS] = "SIOCSLIFFLAGS";
    ioctls[SIOCSLIFNETMASK] = "SIOCSLIFNETMASK";
    ioctls[SIOCSLIFZONE] = "SIOCSLIFZONE";

    ioctls[TCGETS] = "TCGETS";
    ioctls[TCSETS] = "TCGETS";
    ioctls[TCSANOW] = "TCGETS";
    ioctls[TCSETSW] = "TCGETS";
    ioctls[TCSADRAIN] = "TCGETS";
    ioctls[TCSETSF] = "TCGETS";
    ioctls[TCGETA] = "TCGETA";
    ioctls[TCSETA] = "TCSETA";
    ioctls[TCSETAW] = "TCSETAW";
    ioctls[TCSETAF] = "TCSETAF";
    ioctls[TCSBRK] = "TCSBRK";
    ioctls[TCXONC] = "TCXONC";

    ioctls[TIOCGETLD] = "TIOCGETLD";
    ioctls[TIOCGWINSZ] = "TIOCGWINSZ";
    ioctls[TIOCSETLD] = "TIOCSETLD";
    ioctls[TIOCSWINSZ] = "TIOCSWINSZ";
    ioctls[TIOCSCTTY] = "TIOCSCTTY";

    ioctls[ZC_HOLDSLAVE] = "ZC_HOLDSLAVE";
    ioctls[ZC_RELEASESLAVE] = "ZC_RELEASESLAVE";

    ioctls[ZFD_MAKETTY] = "ZFD_MAKETTY";
    ioctls[ZFD_EOF] = "ZFD_EOF";
    ioctls[ZFD_HAS_SLAVE] = "ZFD_HAS_SLAVE";
    ioctls[ZFD_MUX] = "ZFD_MUX";
}

/*
 * Helpers
 */

syscall::open:entry, syscall::open64:entry
{
    self->open_file = arg0;
}

/*
 * Zone startup
 */

fbt:genunix:zsched:entry
{
    printf("%u %*s %s[%d] zsched_entry()\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid
    );
}

fbt:genunix:zone_start_init:entry
{
    printf("%u %*s %s[%d] zone_start_init()\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid
    );

    /*
     * If we see a zone starting up, we'll assume that's the one we're
     * interested in for now.
     */
    docker_zonename = zonename;
    self->starting_init = 1;
}

fbt:genunix:exec_init:entry
/self->starting_init/
{
    printf("%u %*s %s[%d] exec_init(%s)\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        stringof(arg0)
    );
}

fbt:genunix:exec_init:return
/execname == "dockerinit" && self->starting_init/
{
    dockerinit_pid = pid;

    printf("%u %*s %s[%d] exec_init() returned\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid
    );
}

/* XXX: never happens? */
fbt:genunix:zone_start_init:return
{
    self->starting_init = 0;

    printf("%u %*s %s[%d] start_init() returned\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid
    );
}


/*
 * Trace ZFD operations from dockerinit/init
 */

syscall::open:return, syscall::open64:return
/
    execname == "dockerinit" &&
    substr(copyinstr(self->open_file), 0, 9) == "/dev/zfd/"
/
{
    printf("%u %*s %s[%d] ZFD open(%s) = %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        copyinstr(self->open_file),
        arg0
    );
}

lx-syscall::read:entry, syscall::read:entry
/
    (pid == dockerinit_pid || progenyof(dockerinit_pid)) &&
    substr(fds[arg0].fi_pathname, 48, 9) == "/dev/zfd/"
/
{
    self->read_buf = arg1;
    self->read_fd = arg0;

    printf("%u %*s %s[%d] %s::read:entry(%d,%s,%d)\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probeprov,
        arg0,
        substr(fds[arg0].fi_pathname, 48),
        arg2
    );
}

lx-syscall::read:return, syscall::read:return
/(pid == dockerinit_pid || progenyof(dockerinit_pid)) && self->read_buf != NULL/
{
    printf("%u %*s %s[%d] %s::read:return(%d,%s) = '%S'[%d]\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probeprov,
        self->read_fd,
        substr(fds[self->read_fd].fi_pathname, 48),
        (arg0 > 0) ? copyinstr(self->read_buf, arg0) : "",
        arg0
    );

    self->read_buf = 0;
    self->read_fd = 0;
}

lx-syscall::write:entry, syscall::write:entry
/
    (pid == dockerinit_pid || progenyof(dockerinit_pid)) &&
    substr(fds[arg0].fi_pathname, 48, 9) == "/dev/zfd/"
/
{
    self->write_buf = arg1;
    self->write_fd = arg0;

    printf("%u %*s %s[%d] %s::write:entry(%d,%s)\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probeprov,
        arg0,
        substr(fds[self->write_fd].fi_pathname, 48)
    );
}

lx-syscall::write:return, syscall::write:return
/
    (pid == dockerinit_pid || progenyof(dockerinit_pid)) &&
    self->write_buf != NULL
/
{
    printf("%u %*s %s[%d] %s::write:return(%d,%s) = '%S'[%d]\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probeprov,
        self->write_fd,
        substr(fds[self->write_fd].fi_pathname, 48),
        (arg0 > 0) ? copyinstr(self->write_buf, arg0) : "",
        arg0
    );

    self->write_buf = 0;
    self->write_fd = 0;
}

syscall::ioctl:entry, lx-syscall::ioctl:entry
/
    (pid == dockerinit_pid || progenyof(dockerinit_pid)) &&
    substr(fds[arg0].fi_pathname, 48, 9) == "/dev/zfd/"
/
{
    printf("%u %*s %s[%d] %s::%s(%d,%s):%s\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probeprov,
        probefunc,
        arg0,
        (ioctls[arg1] != NULL) ? ioctls[arg1] : lltostr(arg1),
        probename
    );

    self->watching_ioctl = 1;
}

syscall::ioctl:return, lx-syscall::ioctl:return
/(pid == dockerinit_pid || progenyof(dockerinit_pid)) && self->watching_ioctl/
{
    printf("%u %*s %s[%d] %s::%s:%s = %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probeprov,
        probefunc,
        probename,
        arg0
    );

    self->watching_ioctl = 0;
}


/*
 * Grab dockerinit's log messages
 */

syscall::open:return, syscall::open64:return
/
    execname == "dockerinit" &&
    copyinstr(self->open_file) == "/var/log/sdc-dockerinit.log"
/
{
    self->log_fd = arg0;
    printf("%u %*s %s[%d] logging to fd %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        self->log_fd
    );
}

syscall::write:entry
/execname == "dockerinit" && arg0 == self->log_fd/
{
    self->log_write_data = arg1;
}

syscall::write:return
/execname == "dockerinit" && self->log_write_data != NULL/
{
    printf("%u %*s %s[%d] LOG '%S'\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        copyinstr(self->log_write_data, arg0)
    );
    self->log_write_data = 0;
}


/*
 * cn-agent's docker-stdio.js
 */

syscall::open:return, syscall::open64:return
/
    execname == "node" &&
    zonename == "global" &&
    copyinstr(self->open_file) == "/opt/smartdc/agents/lib/node_modules/cn-agent/lib/tasks/docker_exec.js"
/
{
    printf("%u %*s %s[%d] cn-agent tasks/docker_exec.js\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid
    );
    docker_exec_pid = pid;
}

syscall::open:return, syscall::open64:return
/
    execname == "node" &&
    zonename == "global" &&
    copyinstr(self->open_file) == "/opt/smartdc/agents/lib/node_modules/cn-agent/lib/docker-stdio.js"
/
{
    printf("%u %*s %s[%d] cn-agent lib/docker-stdio.js\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid
    );
    docker_stdio_pid = pid;
}


/*
 * zlogin
 */

syscall::exece:return
/docker_stdio_pid > 0 && progenyof(docker_stdio_pid) && execname == "zlogin"/
{
    printf("%u %*s %s[%d] %s:%s\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probefunc,
        probename
    );

    self->zlogin_fds[0] = "stdin";
    self->zlogin_fds[1] = "stdout";
    self->zlogin_fds[2] = "stderr";
    self->zlogin_pid = pid;
}

/*
 * zlogin uses so_socket+connect when opening the connection to the sockets
 * that connect it to zoneadmd. So we trace the connections and add them to
 * zlogin_fds so we can know which is which.
 */
syscall::connect*:entry
/pid == self->zlogin_pid/
{
    /* assume this is sockaddr_un until we can examine family */
    this->s = (struct sockaddr_un *)copyin(arg1, sizeof (struct sockaddr_un));
    this->f = this->s->sun_family;
    self->zlogin_connect_path = stringof(this->s->sun_path);
    self->zlogin_connect_fd = arg0;

    printf("%u %*s %s[%d] connect(%d,%S):entry\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        self->zlogin_connect_fd,
        self->zlogin_connect_path
    );
}

syscall::connect*:return
/
    pid == self->zlogin_pid &&
    arg0 == 0 &&
    self->zlogin_connect_path != NULL &&
    (
        substr(self->zlogin_connect_path, 52) == "server_ctl" ||
        substr(self->zlogin_connect_path, 52) == "server_out" ||
        substr(self->zlogin_connect_path, 52) == "server_err"
    )
/
{
    self->zlogin_fds[self->zlogin_connect_fd] =
        substr(self->zlogin_connect_path, 52);
    self->zlogin_connect_fd = 0;
    self->zlogin_connect_path = 0;
}

syscall::connect*:return
/
    pid == self->zlogin_pid &&
    self->zlogin_connect_path != NULL
/
{
    printf("%u %*s %s[%d] connect(%d,%s) = %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        self->zlogin_connect_fd,
        self->zlogin_connect_path,
        arg0
    );

    self->zlogin_connect_fd = 0;
    self->zlogin_connect_path = 0;
}

syscall::connect*:return
/pid == self->zlogin_pid && self->zlogin_connect_fd/
{
    self->zlogin_connect_fd = 0;
}

syscall::read:entry
/pid == self->zlogin_pid && self->zlogin_fds[arg0] != NULL/
{
    printf("%u %*s %s[%d] read(%d[%s]):entry\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        arg0,
        self->zlogin_fds[arg0]
    );
    self->zlogin_read_buf = arg1;
    self->zlogin_read_fd = arg0;
}

syscall::read:return
/pid == self->zlogin_pid && self->zlogin_read_buf != NULL/
{
    printf("%u %*s %s[%d] read(%d[%s]):return = '%S'[%d]\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        self->zlogin_read_fd,
        self->zlogin_fds[self->zlogin_read_fd],
        (arg0 > 0) ? copyinstr(self->zlogin_read_buf, arg0) : "",
        arg0
    );

    self->zlogin_read_buf = 0;
    self->zlogin_read_fd = 0;
}

syscall::write:entry
/pid == self->zlogin_pid && self->zlogin_fds[arg0] != NULL/
{
    printf("%u %*s %s[%d] write(%d[%s]):entry\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        arg0,
        self->zlogin_fds[arg0]
    );
    self->zlogin_write_fd = arg0;
    self->zlogin_write_data = arg1;
}

syscall::write:return
/pid == self->zlogin_pid && self->zlogin_write_data != NULL/
{
    printf("%u %*s %s[%d] write(%d[%s]):return '%S'[%d]\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        self->zlogin_write_fd,
        self->zlogin_fds[self->zlogin_write_fd],
        (arg0 > 0) ? copyinstr(self->zlogin_write_data, arg0) : "",
        arg0
    );

    self->zlogin_write_data = 0;
    self->zlogin_write_fd = 0;
}

syscall::ioctl:entry
/pid == self->zlogin_pid && self->zlogin_fds[arg0] != NULL/
{
    printf("%u %*s %s[%d] %s(%d[%s],%s):%s\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probefunc,
        arg0,
        self->zlogin_fds[arg0],
        (ioctls[arg1] != NULL) ? ioctls[arg1] : lltostr(arg1),
        probename
    );

    self->zlogin_ioctl = 1;
}

syscall::ioctl:return
/pid == self->zlogin_pid && self->zlogin_ioctl/
{
    printf("%u %*s %s[%d] %s:%s = %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probefunc,
        probename,
        arg0
    );

    self->zlogin_ioctl = 0;
}


/*
 * docker-stdio.js network
 */

syscall::listen:
/pid == docker_stdio_pid/
{
    printf("%u %*s %s[%d] %s:%s\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        (pid == docker_stdio_pid) ? "docker-stdio" : execname,
        pid,
        probefunc,
        probename
    );
}

tcp:::accept-established
/args[1]->cs_pid == docker_stdio_pid/
{
    printf("%u %*s %s[%d] accept(%s:%d)\n",
        timestamp,
        ZONENAME_LEN,
        "global",
        "docker-stdio",
        args[1]->cs_pid,
        args[3]->tcps_raddr,
        args[3]->tcps_rport
    );
}

syscall::accept*:return
/pid == docker_stdio_pid && arg0 > 0/
{
    printf("%u %*s %s[%d] accept() = %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        "docker-stdio",
        pid,
        arg0
    );

    self->stdio_accepted_fds[arg0] = 1;
}

tcp:::state-change
/args[1]->cs_pid == docker_stdio_pid/
{
    printf("%u %*s %s[%d] TCP STATE L(%s:%d) <-> R(%s:%d) %s -> %s\n",
        timestamp,
        ZONENAME_LEN,
        "global",
        "docker-stdio",
        args[1]->cs_pid,
        args[3]->tcps_laddr,
        args[3]->tcps_lport,
        args[3]->tcps_raddr,
        args[3]->tcps_rport,
        tcp_state_string[args[5]->tcps_state],
        tcp_state_string[args[3]->tcps_state]
    );
}

/*
 * We track the port we're listening on so that if/when sdc-docker connects to
 * that port, we know it's talking to us.
 */
tcp:::state-change
/
    docker_stdio_port == -1 &&
    args[1]->cs_pid == docker_stdio_pid &&
    tcp_state_string[args[3]->tcps_state] == "state-listen"
/
{
    printf("%u %*s %s[%d] local port is %d\n",
        timestamp,
        ZONENAME_LEN,
        "global",
        "docker-stdio",
        args[1]->cs_pid,
        args[3]->tcps_lport
    );
    docker_stdio_port = args[3]->tcps_lport;
}

syscall::read:entry
/pid == docker_stdio_pid && self->stdio_accepted_fds[arg0]/
{
    printf("%u %*s %s[%d] read(%d[tcp]):entry\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        "docker-stdio",
        pid,
        arg0
    );

    self->accepted_read_buf = arg1;
    self->accepted_read_fd = arg0;
    self->reading_accepted_fd = 1;
}

syscall::read:return
/self->reading_accepted_fd/
{
    printf("%u %*s %s[%d] read(%d[tcp]):return = '%S'[%d]\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        "docker-stdio",
        pid,
        self->accepted_read_fd,
        (arg0 > 0) ? copyinstr(self->accepted_read_buf, arg0) : "",
        arg0
    );

    self->accepted_read_buf = 0;
    self->accepted_read_fd = 0;
    self->reading_accepted_fd = 0;
}

syscall::write:entry
/pid == docker_stdio_pid && self->stdio_accepted_fds[arg0]/
{
    printf("%u %*s %s[%d] write(%d[tcp]):entry\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        "docker-stdio",
        pid,
        arg0
    );
    self->accepted_write_fd = arg0;
    self->accepted_write_data = arg1;
    self->writing_accepted_fd = 1;
}

syscall::write:return
/self->writing_accepted_fd/
{
    printf("%u %*s %s[%d] write(%d[tcp]):return '%S'[%d]\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        "docker-stdio",
        pid,
        self->accepted_write_fd,
        (arg0 > 0) ? copyinstr(self->accepted_write_data, arg0) : "",
        arg0
    );

    self->accepted_write_fd = 0;
    self->accepted_write_data = 0;
    self->writing_accepted_fd = 0;
}


/*
 * zoneadmd
 */

/* WIP: we likely want more syscalls here, can uncomment this to see them all:

syscall:::
/execname == "zoneadmd" && substr(curpsinfo->pr_psargs, 12) == docker_zonename/
{
    printf("%u %*s %s[%d] %s:%s\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probefunc,
        probename
    );
}
*/

syscall::open:return, syscall::open64:return
/
    execname == "zoneadmd" &&
    substr(curpsinfo->pr_psargs, 12) == docker_zonename &&
    (
        substr(copyinstr(self->open_file), 0, 9) == "/dev/zfd/" ||
        substr(copyinstr(self->open_file), 44) == "/logs/stdio.log"
    )
/
{
    printf("%u %*s %s[%d] zoneadmd open(%s) = %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        copyinstr(self->open_file),
        arg0
    );

    zoneadmd_fds[arg0] = copyinstr(self->open_file);
}

syscall::so_socket:return
/
    execname == "zoneadmd" &&
    substr(curpsinfo->pr_psargs, 12) == docker_zonename
/
{
    printf("%u %*s %s[%d] zoneadmd so_socket(?) = %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        arg0
    );
}

syscall::close:entry
/
    execname == "zoneadmd" &&
    substr(curpsinfo->pr_psargs, 12) == docker_zonename &&
    zoneadmd_fds[arg0] != NULL
/
{
    self->closing_fd = arg0;
}

syscall::close:return
/
    execname == "zoneadmd" &&
    substr(curpsinfo->pr_psargs, 12) == docker_zonename &&
    zoneadmd_fds[self->closing_fd] != NULL
/
{
    printf("%u %*s %s[%d] zoneadmd close(%d) = %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        self->closing_fd,
        arg0
    );

    zoneadmd_fds[self->closing_fd] = 0;
    self->closing_fd = 0;
}

syscall::ioctl:entry
/
    execname == "zoneadmd" &&
    substr(curpsinfo->pr_psargs, 12) == docker_zonename &&
    zoneadmd_fds[arg0] != NULL
/
{
    printf("%u %*s %s[%d] %s(%d[%s],%s):%s\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probefunc,
        arg0,
        fds[arg0].fi_pathname,
        (ioctls[arg1] != NULL) ? ioctls[arg1] : lltostr(arg1),
        probename
    );

    self->zoneadmd_ioctl = 1;
}

syscall::ioctl:return
/
    execname == "zoneadmd" &&
    substr(curpsinfo->pr_psargs, 12) == docker_zonename &&
    self->zoneadmd_ioctl == 1
/
{
    printf("%u %*s %s[%d] %s:%s = %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probefunc,
        probename,
        arg0
    );

    self->zoneadmd_ioctl = 0;
}

syscall::read:entry, syscall::write:entry
/
    execname == "zoneadmd" &&
    substr(curpsinfo->pr_psargs, 12) == docker_zonename &&
    (
        fds[arg0].fi_pathname == NULL ||
        substr(fds[arg0].fi_pathname, 0, 22) == "/devices/pseudo/zfdnex"
    )
/
{
    printf("%u %*s %s[%d] %s(%d[%s],%d):%s\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probefunc,
        arg0,
        (fds[arg0].fi_pathname != NULL) ? fds[arg0].fi_pathname : "<unnamed>",
        arg2,
        probename
    );

    self->zoneadmd_io_buf = arg1;
    self->zoneadmd_io_fd = arg0;
    self->zoneadmd_io = 1;
}

syscall::read:return, syscall::write:return
/execname == "zoneadmd" && self->zoneadmd_io/
{
    printf("%u %*s %s[%d] %s(%d[%s]):return = '%S'[%d]\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        execname,
        pid,
        probefunc,
        self->zoneadmd_io_fd,
        (fds[self->zoneadmd_io_fd].fi_pathname != NULL) ?
            fds[self->zoneadmd_io_fd].fi_pathname : "<unnamed>",
        (arg0 > 0) ? copyinstr(self->zoneadmd_io_buf, arg0) : "",
        arg0
    );

    self->zoneadmd_io_buf = 0;
    self->zoneadmd_io_fd = 0;
    self->zoneadmd_io = 0;
}


/*
 * If we're on the HN (eg. COAL) we can look at sdc-docker too.
 */

syscall::accept:entry
/
    sdc_docker_pid == -1 &&
    zonename != "global" &&
    execname == "node" &&
    substr(curpsinfo->pr_psargs, 0, 39) == "/opt/smartdc/docker/build/node/bin/node"
/
{
    printf("%u %*s %s[%d] sdc-docker is '%s'\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        "sdc-docker",
        pid,
        curpsinfo->pr_psargs
    );

    sdc_docker_pid = pid;
    docker_zonename = zonename;
}

syscall::accept:return
/pid == sdc_docker_pid/
{
    /* this should be the FD docker client we just accepted */
    sdc_docker_client_fds[arg0] = 1;
}

syscall::connect:entry
/pid == sdc_docker_pid/
{
    self->connect_fd = arg0;
    self->connect_sockaddr = arg1;
    self->connect_sockaddr_len = arg2;
}

syscall::connect:return
/pid == sdc_docker_pid/
{
    this->connect_sock = (struct sockaddr_in *)copyin(self->connect_sockaddr,
        self->connect_sockaddr_len);
    self->connect_port = ntohs(this->connect_sock->sin_port);
}

syscall::connect:return
/
    pid == sdc_docker_pid &&
    self->connect_port == docker_stdio_port
/
{
    sdc_docker_agent_fds[self->connect_fd] = 1;
}

syscall::connect:return
/pid == sdc_docker_pid/
{
    self->connect_fd = 0;
    self->connect_port = 0;
    self->connect_sockaddr = 0;
    self->connect_sockaddr_len = 0;
}

tcp:::accept-established
/
    args[1]->cs_pid == sdc_docker_pid &&
    (args[3]->tcps_lport == 2375 || args[3]->tcps_lport == 2376)
/
{
    printf("%u %*s %s[%d] TCP ACCEPTED R(%s:%d) -> L(%s:%d)\n",
        timestamp,
        ZONENAME_LEN,
        substr(docker_zonename, 0, ZONENAME_LEN),
        "sdc-docker",
        args[1]->cs_pid,
        args[3]->tcps_raddr,
        args[3]->tcps_rport,
        args[3]->tcps_laddr,
        args[3]->tcps_lport
    );

    /*
     * we just got a connection on docker port, assume the address they
     * connected to is our external.
     */
    sdc_docker_ext_addr = args[3]->tcps_laddr;
}

tcp:::state-change
/
    args[1]->cs_pid == sdc_docker_pid &&
    (
        args[3]->tcps_lport == 2375 ||
        args[3]->tcps_lport == 2376 ||
        args[3]->tcps_rport == docker_stdio_port
    )
/
{
    printf("%u %*s %s[%d] TCP STATE L(%s:%d) <-> R(%s:%d) %s -> %s\n",
        timestamp,
        ZONENAME_LEN,
        substr(docker_zonename, 0, ZONENAME_LEN),
        "sdc-docker",
        args[1]->cs_pid,
        args[3]->tcps_laddr,
        args[3]->tcps_lport,
        args[3]->tcps_raddr,
        args[3]->tcps_rport,
        tcp_state_string[args[5]->tcps_state],
        tcp_state_string[args[3]->tcps_state]
    );
}

syscall::read:entry, syscall::write:entry
/
    pid == sdc_docker_pid &&
    (
        sdc_docker_client_fds[arg0] ||
        sdc_docker_agent_fds[arg0]
    )
/
{
    printf("%u %*s %s[%d] %s(%d[%s],%d):%s\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        "sdc-docker",
        pid,
        probefunc,
        arg0,
        sdc_docker_client_fds[arg0] ? "client" :
            (sdc_docker_agent_fds[arg0] ? "agent" : "tcp"),
        arg2,
        probename
    );

    self->sdc_docker_io_buf = arg1;
    self->sdc_docker_io_fd = arg0;
    self->sdc_docker_io = 1;
}

syscall::read:return, syscall::write:return
/
    pid == sdc_docker_pid &&
    self->sdc_docker_io
/
{
    printf("%u %*s %s[%d] %s(%d[%s]):return = '%S'[%d]\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        "sdc-docker",
        pid,
        probefunc,
        self->sdc_docker_io_fd,
        sdc_docker_client_fds[self->sdc_docker_io_fd] ? "client" :
            (sdc_docker_agent_fds[self->sdc_docker_io_fd] ? "agent" : "tcp"),
        (arg0 > 0) ? copyinstr(self->sdc_docker_io_buf, arg0) : "",
        arg0
    );

    self->sdc_docker_io_buf = 0;
    self->sdc_docker_io_fd = 0;
    self->sdc_docker_io = 0;
}


/*
 * Handle exit()'s
 */

proc:::exit
/
    (
        pid == dockerinit_pid ||
        pid == docker_exec_pid ||
        pid == docker_stdio_pid ||
        pid == self->zlogin_pid ||
        (
            execname == "zoneadmd" &&
            substr(curpsinfo->pr_psargs, 12) == docker_zonename
        )
    ) &&
    arg0 <= 3
/
{
    printf("%u %*s %s[%d] exited due to %s\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        (pid == docker_stdio_pid) ? "docker-stdio" :
            (pid == docker_exec_pid) ? "docker_exec" : execname,
        pid,
        (arg0 == 1)? "call to exit system call":
            ((arg0 == 2)? "receiving a signal":
                "receiving a signal and has a core dump")
    );
}

proc:::signal-send
/
    args[1]->pr_pid == dockerinit_pid ||
    args[1]->pr_pid == docker_exec_pid ||
    args[1]->pr_pid == docker_stdio_pid ||
    args[1]->pr_pid == self->zlogin_pid ||
    (
        execname == "zoneadmd" &&
        substr(curpsinfo->pr_psargs, 12) == docker_zonename
    )
/
{
    printf("%u %*s %s[%d] sending signal %d[%s] to pid %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        (pid == docker_stdio_pid) ? "docker-stdio" :
            (pid == docker_exec_pid) ? "docker_exec" : execname,
        pid,
        args[2],
        sig[args[2]],
        args[1]->pr_pid
    );
}

syscall::rexit:entry
/
    pid == dockerinit_pid ||
    pid == docker_exec_pid ||
    pid == docker_stdio_pid ||
    pid == self->zlogin_pid ||
    (
        execname == "zoneadmd" &&
        substr(curpsinfo->pr_psargs, 12) == docker_zonename
    )
/
{
    printf("%u %*s %s[%d] exited with status %d\n",
        timestamp,
        ZONENAME_LEN,
        substr(zonename, 0, ZONENAME_LEN),
        (pid == docker_stdio_pid) ? "docker-stdio" :
            (pid == docker_exec_pid) ? "docker_exec" : execname,
        pid,
        arg0
    );
}


/*
 * Cleanup
 */
syscall::open:return, syscall::open64:return
{
    self->open_file = 0;
}
