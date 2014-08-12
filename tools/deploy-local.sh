set -o xtrace
DIRNAME=$(cd `dirname $0`/.. && pwd)
cd $DIRNAME

rsync --recursive --partial -l ./{package.json,deps,bin,lib,test} /opt/smartdc/agents/lib/node_modules/cn-agent

if [[ -z "$NO_RESTART" ]]; then
    svcadm restart cn-agent
    svcadm clear cn-agent
fi
