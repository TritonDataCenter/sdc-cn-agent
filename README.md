# SmartDataCenter Compute Node Agent

Repository: <git@git.joyent.com:sdc-cn-agent.git>
Browsing: <https://mo.joyent.com/sdc-cn-agent>
Who: Orlando Vazquez
Docs: <https://mo.joyent.com/docs/sdc-cn-agent>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/AGENT>


# Overview

The SmartDatacenter Compute Node Agent (or cn-agent, for short) is an
RPC mechanism via which a client can interact with a compute node. It
acts as an externally visible interface to subsystems within the server. 

Cn-agent is responsible for executing "tasks", scripts which break down some
unit of work into a number of steps to be completed.  This may be may range
from creating a virtual machine to something as simple as creating or listing
ZFS datasets.


# Repository

    deps/           Git submodules and/or commited 3rd-party deps should go
                    here. See "node_modules/" for node.js deps.
    docs/           Project docs (restdown)
    lib/            Source files.
    node_modules/   Node.js deps, either populated at build time or commited.
                    See Managing Dependencies.
    pkg/            Package lifecycle scripts
    smf/manifests   SMF manifests
    smf/methods     SMF method scripts
    test/           Test suite (using node-tap)
    tools/          Miscellaneous dev/upgrade/deployment tools and data.
    Makefile
    package.json    npm module info (holds the project version)
    README.md


# Development

To run the cn-agent:

    git clone git@git.joyent.com:sdc-cn-agent.git
    cd sdc-cn-agent
    git submodule update --init
    make all
    node bin/cn-agent


# Documentation

To update the documentation, edit "docs/index.restdown" and run `make docs`
to update "docs/index.html".

Before commiting/pushing run `make prepush` and, if possible, get a code
review.


# Design

(See docs/index.restdown for more in-depth details)


# Testing

    make test
