/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

@Library('jenkins-joylib@v1.0.6') _

pipeline {

    agent {
        label joyCommonLabels(image_ver: '15.4.1')
    }

    options {
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timestamps()
    }

    parameters {
        booleanParam(
            name: 'TRIGGER_AGENTS_INSTALLER_BUILD',
            defaultValue: true,
            description:
                'After a build of this agent, by default we trigger a build ' +
                'of the master branch of sdc-agents-installer, so that this ' +
                'agent can be tested in a Triton instance. Uncheck this to ' +
                'prevent that build from being triggered.'
            )
    }

    stages {
        stage('check') {
            steps{
                sh('make check')
            }
        }
        // avoid bundling devDependencies
        stage('re-clean') {
            steps {
                sh('git clean -fdx')
            }
        }
        stage('build image and upload') {
            steps {
                sh('''
set -o errexit
set -o pipefail

export ENGBLD_BITS_UPLOAD_IMGAPI=true
make print-BRANCH print-STAMP all release publish bits-upload''')
            }
        }
        stage('agentsshar') {
            // For release branch builds, we'll wait for the
            // sdc-agents-installer build to run on its own.
            // Otherwise if we were to trigger a release-* branch build at this
            // point, we can't guarantee all agent builds have completed.
            // Eventually it would be good to have a pipeline that builds all
            // agents in parallel, and then the agents-installer. In that case,
            // callers should explicitly set the TRIGGER_AGENTS_INSTALLER build
            // to 'false'
            // For normal development, it's fine to always trigger the master
            // sdc-agents-installer build.
            when {
                not {
                    anyOf {
                        branch 'release-*'
                        environment name: 'TRIGGER_AGENTS_INSTALLER_BUILD', value: 'false'
                    }
                }
            }
            steps {
                build(
                    job:'joyent-org/sdc-agents-installer/master',
                    wait: false,
                    propagate: false,
                    parameters: [
                        [$class: 'StringParameterValue',
                        name: 'BUILDNAME',
                        value: env.BRANCH_NAME + ' master',
                        ]
                    ])
            }
        }
    }

    post {
        always {
            joyMattermostNotification(channel: 'jenkins')
        }
    }

}
