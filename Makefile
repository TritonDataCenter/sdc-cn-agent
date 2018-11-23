#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#

#
# Files
#
DOC_FILES =		index.md
JS_FILES :=		$(shell ls *.js 2>/dev/null) \
			$(shell find bin lib test -name '*.js' 2>/dev/null)
JSL_CONF_NODE =		tools/jsl.node.conf
JSL_FILES_NODE =	$(JS_FILES)
JSSTYLE_FILES =		$(JS_FILES)
JSSTYLE_FLAGS =		-o indent=4,doxygen,unparenthesized-return=0

# The next line breaks the build due to a variable that eng.git sed expander
# doesn't know about (@@ENABLED@@)
# SMF_MANIFESTS_IN = smf/manifests/cn-agent.xml.in

NODE_PREBUILT_VERSION =	v6.14.0
NODE_PREBUILT_TAG =	gz
ifeq ($(shell uname -s),SunOS)
NODE_PREBUILT_IMAGE =	18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

# Included definitions
include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	NPM=npm
	NODE=node
	NPM_EXEC=$(shell which npm)
	NODE_EXEC=$(shell which node)
endif
include ./tools/mk/Makefile.node_deps.defs
include ./tools/mk/Makefile.smf.defs

NAME :=	cn-agent
RELEASE_TARBALL :=	$(NAME)-$(STAMP).tgz
RELEASE_MANIFEST :=	$(NAME)-$(STAMP).manifest
RELSTAGEDIR :=		/tmp/$(STAMP)
NODEUNIT =		$(TOP)/node_modules/.bin/nodeunit
ZFS_SNAPSHOT_TAR :=	$(TOP)/deps/zfs_snapshot_tar/zfs_snapshot_tar
NOMKNOD :=	$(TOP)/src/nomknod/nomknod.32.so \
	$(TOP)/src/nomknod/nomknod.64.so

COAL ?= root@10.99.99.7

#
# Due to the unfortunate nature of npm, the Node Package Manager, there appears
# to be no way to assemble our dependencies without running the lifecycle
# scripts.  These lifecycle scripts should not be run except in the context of
# an agent installation or uninstallation, so we provide a magic environment
# varible to disable them here.
#
NPM_ENV =		SDC_AGENT_SKIP_LIFECYCLE=yes \
			MAKE_OVERRIDES='CTFCONVERT=/bin/true CTFMERGE=/bin/true'
RUN_NPM_INSTALL =	$(NPM_ENV) $(NPM) install

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NPM_EXEC) $(REPO_DEPS) $(ZFS_SNAPSHOT_TAR) $(NOMKNOD)
	$(RUN_NPM_INSTALL)

$(NODEUNIT): | $(NPM_EXEC)
	$(RUN_NPM_INSTALL)

#
# Unfortunately we don't have the CTF tools available during this build.  We
# stub out their execution below, but also prevent stripping the binary.
# Shipped binaries will, at least, contain DWARF.
#
$(ZFS_SNAPSHOT_TAR): deps/zfs_snapshot_tar/.git
	cd $(@D) && $(MAKE) \
	    CTFCONVERT=/bin/true \
	    CTFMERGE=/bin/true \
	    STRIP=/bin/true \
	    $(@F)

$(NOMKNOD): src/nomknod/nomknod.c src/nomknod/Makefile
	cd $(@D) && $(MAKE)

CLEAN_FILES += $(NODEUNIT) ./node_modules/tap $(NOMKNOD)

.PHONY: test
test:
	./test/runtests

.PHONY: test-coal
test-coal:
	./tools/rsync-to coal
	ssh $(COAL) 'cd /opt/smartdc/agents/lib/node_modules/cn-agent \
	    && /opt/smartdc/agents/lib/node_modules/cn-agent/node/bin/node \
	    /opt/smartdc/agents/lib/node_modules/cn-agent/node_modules/.bin/nodeunit \
	    --reporter default'

.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/$(NAME)
	cd $(TOP) && $(RUN_NPM_INSTALL)
	(git symbolic-ref HEAD | awk -F/ '{print $$3}' && git describe) > $(TOP)/describe
	cp -r \
	    $(TOP)/Makefile \
	    $(TOP)/bin \
	    $(TOP)/build/node \
	    $(TOP)/describe \
	    $(TOP)/lib \
	    $(TOP)/node_modules \
	    $(TOP)/npm \
	    $(TOP)/package.json \
	    $(TOP)/sapi_manifests \
	    $(TOP)/smf \
	    $(TOP)/test \
	    $(TOP)/tools \
	    $(RELSTAGEDIR)/$(NAME)
	cp $(ZFS_SNAPSHOT_TAR) \
	    $(RELSTAGEDIR)/$(NAME)/lib/zfs_snapshot_tar
	cp $(NOMKNOD) \
	    $(RELSTAGEDIR)/$(NAME)/lib/
	# Trim node
	rm -rf \
	    $(RELSTAGEDIR)/$(NAME)/node/bin/npm \
	    $(RELSTAGEDIR)/$(NAME)/node/lib/node_modules \
	    $(RELSTAGEDIR)/$(NAME)/node/include \
	    $(RELSTAGEDIR)/$(NAME)/node/share
	uuid -v4 >$(RELSTAGEDIR)/cn-agent/image_uuid
	cd $(RELSTAGEDIR) && $(TAR) -zcf $(TOP)/$(RELEASE_TARBALL) *
	cat $(TOP)/manifest.tmpl | sed \
	    -e "s/UUID/$$(cat $(RELSTAGEDIR)/cn-agent/image_uuid)/" \
	    -e "s/NAME/$$(json name < $(TOP)/package.json)/" \
	    -e "s/VERSION/$$(json version < $(TOP)/package.json)/" \
	    -e "s/DESCRIPTION/$$(json description < $(TOP)/package.json)/" \
	    -e "s/BUILDSTAMP/$(STAMP)/" \
	    -e "s/SIZE/$$(stat --printf="%s" $(TOP)/$(RELEASE_TARBALL))/" \
	    -e "s/SHA/$$(openssl sha1 $(TOP)/$(RELEASE_TARBALL) \
	    | cut -d ' ' -f2)/" \
	    > $(TOP)/$(RELEASE_MANIFEST)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
	    @echo "error: 'BITS_DIR' must be set for 'publish' target"; \
	    exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp $(TOP)/$(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)
	cp $(TOP)/$(RELEASE_MANIFEST) $(BITS_DIR)/$(NAME)/$(RELEASE_MANIFEST)

.PHONY: dumpvar
dumpvar:
	@if [[ -z "$(VAR)" ]]; then \
	    echo "error: set 'VAR' to dump a var"; \
	    exit 1; \
	fi
	@echo "$(VAR) is '$($(VAR))'"

clean::
	-cd deps/zfs_snapshot_tar && $(MAKE) clobber

# Here "cutting a release" is just tagging the current commit with
# "v(package.json version)". We don't publish this to npm.
.PHONY: cutarelease
cutarelease:
	@echo "# Ensure working copy is clean."
	[[ -z `git status --short` ]]  # If this fails, the working dir is dirty.
	@echo "# Ensure have 'json' tool."
	which json 2>/dev/null 1>/dev/null
	ver=$(shell cat package.json | json version) && \
	    git tag "v$$ver" && \
	    git push origin "v$$ver"


include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
endif
include ./tools/mk/Makefile.node_deps.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
