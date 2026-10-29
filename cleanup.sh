#!/usr/bin/env bash
# Delete everything this project created (tag Project=$PROJECT + named IAM/ECR resources).
# Prints the plan first and only proceeds after you type "yes". Never touches the shard bucket.
set -uo pipefail
source "$(dirname "$0")/aws/lib.sh"
ROLE=$PROJECT-node-role; PROF=$PROJECT-node-profile; ECR=$PROJECT-engine
INST=$(aws ec2 describe-instances "${R[@]}" --filters Name=tag:Project,Values=$PROJECT Name=instance-state-name,Values=pending,running,stopping,stopped \
       --query 'Reservations[].Instances[].InstanceId' --output text)
ALLOC=$(aws ec2 describe-addresses "${R[@]}" --filters Name=tag:Project,Values=$PROJECT --query 'Addresses[].AllocationId' --output text)
SGID=$(aws ec2 describe-security-groups "${R[@]}" --filters Name=group-name,Values=$PROJECT-sg --query 'SecurityGroups[].GroupId' --output text)
echo "=== cleanup plan ($REGION) ==="
echo "terminate instances : ${INST:-none}   (root volumes are deleted with them)"
echo "release Elastic IPs : ${ALLOC:-none}"
echo "delete SG           : ${SGID:-none} ($PROJECT-sg)"
echo "delete key pair     : $PROJECT-key   (local keys/ kept)"
echo "delete ECR repo     : $ECR (with all images)"
echo "delete IAM          : instance profile $PROF, role $ROLE (+ inline policy)"
read -r -p "Type yes to delete all of the above: " A; [ "$A" = yes ] || { echo aborted; exit 1; }
[ -n "$INST" ] && { aws ec2 terminate-instances "${R[@]}" --instance-ids $INST >/dev/null; aws ec2 wait instance-terminated "${R[@]}" --instance-ids $INST; echo "instances terminated"; }
for a in $ALLOC; do aws ec2 release-address "${R[@]}" --allocation-id $a && echo "released $a"; done
[ -n "$SGID" ] && aws ec2 delete-security-group "${R[@]}" --group-id $SGID && echo "SG deleted"
aws ec2 delete-key-pair "${R[@]}" --key-name $PROJECT-key && echo "key pair deleted"
aws ecr delete-repository "${R[@]}" --repository-name $ECR --force >/dev/null && echo "ECR repo deleted"
aws iam remove-role-from-instance-profile --instance-profile-name $PROF --role-name $ROLE 2>/dev/null
aws iam delete-instance-profile --instance-profile-name $PROF 2>/dev/null && echo "instance profile deleted"
for p in $(aws iam list-role-policies --role-name $ROLE --query PolicyNames --output text 2>/dev/null); do aws iam delete-role-policy --role-name $ROLE --policy-name $p; done
aws iam delete-role --role-name $ROLE 2>/dev/null && echo "role deleted"
echo "remaining tagged resources:"; aws resourcegroupstaggingapi get-resources "${R[@]}" --tag-filters Key=Project,Values=$PROJECT --query 'ResourceTagMappingList[].ResourceARN' --output text
