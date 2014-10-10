#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
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
DOC_FILES	 = index.md
JS_FILES	:= $(shell ls *.js 2>/dev/null) $(shell find lib test -name '*.js' 2>/dev/null)
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS    = -o indent=4,doxygen,unparenthesized-return=0

# The next line breaks the build due to a variable that eng.git sed expander
# doesn't know about (@@ENABLED@@)
# SMF_MANIFESTS_IN = smf/manifests/cn-agent.xml.in

# Should be the same version as the platform's /usr/node/bin/node.
NODE_PREBUILT_VERSION=v0.11.14
NODE_PREBUILT_TAG=gz
ifeq ($(shell uname -s),SunOS)
    NODE_PREBUILT_IMAGE=fd2cc906-8938-11e3-beab-4359c665ac99
endif

# Included definitions
include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.node_prebuilt.defs
include ./tools/mk/Makefile.node_deps.defs
include ./tools/mk/Makefile.smf.defs

NAME		:= cn-agent
RELEASE_TARBALL := $(NAME)-$(STAMP).tgz
RELEASE_MANIFEST := $(NAME)-$(STAMP).manifest
RELSTAGEDIR          := /tmp/$(STAMP)
NODEUNIT	= $(TOP)/node_modules/.bin/nodeunit

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NPM_EXEC) $(REPO_DEPS)
	$(NPM) install

$(NODEUNIT): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(NODEUNIT) ./node_modules/tap

.PHONY: test
test:
	$(NODEUNIT) test/*.test.js

.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/$(NAME)
	cd $(TOP) && $(NPM) install
	(git symbolic-ref HEAD | awk -F/ '{print $$3}' && git describe) > $(TOP)/describe
	cp -r \
    $(TOP)/Makefile \
    $(TOP)/bin \
    $(TOP)/describe \
    $(TOP)/lib \
    $(TOP)/node_modules \
    $(TOP)/npm \
    $(TOP)/package.json \
    $(TOP)/smf \
    $(TOP)/test \
    $(TOP)/tools \
    $(RELSTAGEDIR)/cn-agent
	uuid -v4 >$(RELSTAGEDIR)/cn-agent/image_uuid
	(cd $(RELSTAGEDIR) && $(TAR) -zcf $(TOP)/$(RELEASE_TARBALL) *)
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

include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.node_prebuilt.targ
include ./tools/mk/Makefile.node_deps.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
