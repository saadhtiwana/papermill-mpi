#!/usr/bin/env bash
# Deploy on all 3 nodes: DATA_SRC files (sha256 verified after copy), the shards from S3, a shared mpiuser ssh key,
# the image digest from aws/05_build.sh, `docker compose up -d` with ROLE, and /data/hosts on the master.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
: "${IMAGE:?run aws/05_build.sh first}"
mkdir -p keys/mpiuser
[ -f keys/mpiuser/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C mpiuser@$PROJECT -f keys/mpiuser/id_ed25519
FILES=$(cd "$DATA_SRC" && ls settings.txt extra.jsonl 2>/dev/null)
WANT=$(cd "$DATA_SRC" && for f in $FILES; do printf '%s  /data/%s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"; done)
PFX=${SHARD_PREFIX:+$SHARD_PREFIX/}
MPIRUN_ARGS="--mca btl_tcp_if_include $CIDR --mca oob_tcp_if_include $CIDR"
deploy() {   # role public_ip
  local role=$1 ip=$2
  ssh -n "${K[@]}" ubuntu@$ip 'mkdir -p /opt/papermill/ssh /data/shards'
  (cd "$DATA_SRC" && scp -q -p "${K[@]}" $FILES ubuntu@$ip:/data/)
  scp -q "${K[@]}" docker-compose.yml ubuntu@$ip:/opt/papermill/docker-compose.yml
  scp -q "${K[@]}" keys/mpiuser/id_ed25519 keys/mpiuser/id_ed25519.pub ubuntu@$ip:/opt/papermill/ssh/
  ssh -n "${K[@]}" ubuntu@$ip "set -e
    printf '%s\n' '$WANT' | sha256sum -c --quiet && echo '$role: data files sha256 OK'
    cd /opt/papermill/ssh && cp id_ed25519.pub authorized_keys && chmod 700 . && chmod 600 id_ed25519 authorized_keys
    printf 'Host *\n    Port 2222\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n    LogLevel ERROR\n' > config; chmod 600 config
    cd /data/shards && for s in $SHARDS; do printf '%03d\n' \$s; done | xargs -P 32 -I{} sh -c \
      '[ -s shard-{}.jsonl.gz ] || aws s3 cp --region $REGION --only-show-errors s3://$SHARD_BUCKET/${PFX}shard-{}.jsonl.gz shard-{}.jsonl.gz'
    ls | xargs -P 2 -n 10 gzip -t && echo \"$role: \$(ls | wc -l) shards, gzip OK\"
    printf 'IMAGE=%s\nROLE=%s\nIMAGE_DIGEST=%s\nMPIRUN_ARGS=%s\nMASTER_CMD=%s\n' '$IMAGE' '$role' '$IMAGE_DIGEST' '$MPIRUN_ARGS' '$MASTER_CMD' > /opt/papermill/.env
    aws ecr get-login-password --region $REGION | sudo docker login --username AWS --password-stdin ${REPO%%/*} >/dev/null 2>&1
    cd /opt/papermill && sudo docker compose pull -q && sudo docker compose up -d"
}
deploy master $PUB_master &
deploy worker $PUB_w1 &
deploy worker $PUB_w2 &
wait
printf '%s slots=%s\n' $PRIV_master $SLOTS $PRIV_w1 $SLOTS $PRIV_w2 $SLOTS | ssh "${K[@]}" ubuntu@$PUB_master 'cat > /data/hosts; cat /data/hosts'
