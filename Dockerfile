# papermill-mpi node image: the same image runs on every node (master and workers).
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ openmpi-bin libopenmpi-dev openssh-server openssh-client python3 curl \
        zlib1g-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# non-root MPI user (OpenMPI refuses to run as root); uid 1000 matches the default user of most cloud images,
# so a mounted ssh folder keeps sane ownership
RUN useradd -m -u 1000 -s /bin/bash mpiuser && usermod -p '*' mpiuser \
    && mkdir -p /data /run/sshd && chown mpiuser:mpiuser /data

COPY engine/ /src/engine/
RUN mpicxx -O3 -fopenmp -std=c++17 -o /opt/engine /src/engine/engine.cpp -lz && chmod 755 /opt/engine

# sshd on 2222, key login only, mpiuser only; client defaults for mpiuser (port 2222, no host-key prompts)
COPY docker/sshd_config /etc/ssh/sshd_config.d/papermill.conf
COPY docker/ssh_client.conf /etc/ssh/ssh_config.d/papermill.conf
RUN ssh-keygen -A
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
# optional web console (standard-library Python); started on the master through MASTER_CMD
COPY web/ /opt/web/

ENV ROLE=worker
ENTRYPOINT ["/entrypoint.sh"]
