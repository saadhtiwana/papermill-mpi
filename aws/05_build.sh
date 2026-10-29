#!/usr/bin/env bash
# Build the image on the master (native amd64, close to ECR), push it, record IMAGE / IMAGE_DIGEST in aws/ids.env.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
TMP=$(mktemp -d)
COPYFILE_DISABLE=1 tar czf $TMP/src.tgz Dockerfile .dockerignore docker engine
scp -q "${K[@]}" $TMP/src.tgz ubuntu@$PUB_master:/opt/papermill/src.tgz
TAG=$(date +%Y%m%d%H%M)-$(cat engine/* | shasum -a 256 | cut -c1-8)
DIG=$(ssh "${K[@]}" ubuntu@$PUB_master "set -e; mkdir -p /opt/papermill/src && cd /opt/papermill/src && tar xzf ../src.tgz 2>/dev/null
  sudo docker build -q -t $PROJECT:build . > ../build.log 2>&1 || { tail -30 ../build.log >&2; exit 1; }
  aws ecr get-login-password --region $REGION | sudo docker login --username AWS --password-stdin ${REPO%%/*} >/dev/null 2>&1
  sudo docker tag $PROJECT:build $REPO:$TAG && sudo docker push -q $REPO:$TAG >/dev/null
  sudo docker inspect --format '{{index .RepoDigests 0}}' $REPO:$TAG | cut -d@ -f2")
setvar IMAGE_TAG $TAG; setvar IMAGE_DIGEST $DIG; setvar IMAGE $REPO@$DIG
echo "IMAGE=$IMAGE"
