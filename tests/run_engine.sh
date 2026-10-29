#!/bin/bash
# run_engine.sh DATA "LAUNCH" QUERYFILE SHARDS... : index with LAUNCH (e.g. "env OMP_NUM_THREADS=4 /opt/engine" or
# "mpirun -np 3 ... /opt/engine"), then print "## q" + results for every query. Progress goes to DATA/progress.txt.
data=$1; launch=$2; qf=$3; shift 3
PAPERMILL_DATA=$data $launch index "$@" > $data/progress.txt 2> $data/index.err || { cat $data/index.err; exit 1; }
# mpirun forwards stdin to rank 0, so every search gets /dev/null or it would swallow the query list
while IFS= read -r q; do echo "## $q"; PAPERMILL_DATA=$data $launch search "$q" < /dev/null; done < $qf
