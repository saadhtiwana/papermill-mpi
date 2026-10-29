#!/usr/bin/env bash
# Run the engine on the cluster from your machine (search must use the same -np as the index it reads):
#   bash aws/07_run.sh 3 2 index 0 1 2 3          3 ranks (one per node) x 2 OpenMP threads
#   bash aws/07_run.sh 3 2 search "dark matter halo"
set -euo pipefail
source "$(dirname "$0")/lib.sh"
NP=$1; T=$2; shift 2
ARGS=$(printf '%q ' "$@")
ssh "${K[@]}" ubuntu@$PUB_master "sudo docker exec -u mpiuser -e OMP_NUM_THREADS=$T papermill-node bash -c \
  'mpirun --hostfile /data/hosts -np $NP --map-by node --mca plm_rsh_args \"-p 2222\" \$MPIRUN_ARGS -x OMP_NUM_THREADS /opt/engine $ARGS < /dev/null'"
