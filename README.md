<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# sdc-cn-agent

**This branch is used for the port of cn-agent to Linux.  It is not complete.**

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --
*Triton does not use GitHub PRs* -- and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

sdc-cn-agent is an RPC mechanism via which a client can interact with a
compute node. It acts as an externally visible interface to subsystems within
the server. 

It is responsible for executing "tasks", scripts which break down some
unit of work into a number of steps to be completed.  This may range
from creating a virtual machine to something as simple as creating or listing
ZFS datasets.


# Repository

Some notable parts of the repo:

XXX this is bogus!

    node_modules/fw         This is a copy of smartos-live.git:src/fw
                            and should be kept in sync. It is used to
                            provide a node API to `fw.{update,del,add}`
                            for firewall data.


# Development

To run the cn-agent:

    git clone git@github.com:joyent/sdc-cn-agent.git
    cd sdc-cn-agent
    git submodule update --init

## Linux port

To build, you need node 6, as this requires lockfd, which has not yet been
updated for node 8+.

```
$ curl https://nodejs.org/dist/v6.17.1/node-v6.17.1-linux-x64.tar.gz | sudo tar xzf - -C /opt
$ PATH=/opt/node-v6.17.1-linux-x64/bin:$PATH make
```

The plan:

- Initially no support for:
  - Docker
  - Snapshots
  - Migration
- Explore the use of [node-libvirt](https://github.com/hooklift/node-libvirt) to
  implement the required tasks.
