#!/usr/bin/env bash
# Change the instance type of the 3 existing nodes in place (EBS volumes, Elastic IP and private IPs are kept).
#   bash aws/03_resize.sh r5.large       leaves the nodes stopped
set -euo pipefail
source "$(dirname "$0")/lib.sh"
TYPE=${1:?usage: 03_resize.sh <instance-type>}
IDS="$ID_master $ID_w1 $ID_w2"
aws ec2 stop-instances "${R[@]}" --instance-ids $IDS >/dev/null
aws ec2 wait instance-stopped "${R[@]}" --instance-ids $IDS
for i in $IDS; do aws ec2 modify-instance-attribute "${R[@]}" --instance-id $i --instance-type "{\"Value\":\"$TYPE\"}"; done
aws ec2 describe-instances "${R[@]}" --instance-ids $IDS --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name]' --output text
