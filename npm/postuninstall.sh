export SMFDIR=$npm_config_smfdir

svcadm disable -s cn-agent
svccfg delete cn-agent

rm -f "$SMFDIR/cn-agent.xml"
