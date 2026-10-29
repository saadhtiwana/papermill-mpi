// common.hpp - shared types, globals, error handling and path configuration.
#pragma once
#include <mpi.h>
#include <omp.h>
#include <zlib.h>

#include <dirent.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <queue>
#include <regex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using u8 = uint8_t;
using u32 = uint32_t;
using u64 = uint64_t;
using uc = unsigned char;

inline int RANK = 0, NP = 1;
inline std::string DATA = "/data";  // $PAPERMILL_DATA

[[noreturn]] inline void die(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "[engine rank %d] error: ", RANK);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    fflush(stderr);
    MPI_Abort(MPI_COMM_WORLD, 1);
    std::exit(1);
}

inline double now() {
    return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

inline void logr0(const char* fmt, ...) {  // timing log of rank 0 -> stderr
    if (RANK != 0) return;
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "[engine] ");
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}


// ------------------------------------------------------------------ paths (see README, "Configuration")
inline std::string env_or(const char* k, const std::string& d) {
    const char* v = getenv(k);
    return v && *v ? std::string(v) : d;
}
inline std::string settings_path() { return env_or("PAPERMILL_SETTINGS", DATA + "/settings.txt"); }
inline std::string index_dir() { return env_or("PAPERMILL_INDEX", DATA + "/index"); }
// shard number -> file; pattern relative to the data root unless absolute; exactly one %d-style conversion
inline std::string shard_path(int shard) {
    static const std::string pat = env_or("PAPERMILL_SHARD_PATTERN", "shards/shard-%03d.jsonl.gz");
    static const bool ok = std::regex_match(pat, std::regex("[^%]*%0?[0-9]*d[^%]*"));
    if (!ok) die("PAPERMILL_SHARD_PATTERN needs exactly one %%d conversion: %s", pat.c_str());
    char b[4096];
    snprintf(b, sizeof b, pat.c_str(), shard);
    return b[0] == '/' ? std::string(b) : DATA + "/" + b;
}
// optional extra documents read (and counted in N) on every index run, e.g. synthetic sentinel documents.
// PAPERMILL_EXTRA=<file> (must exist), PAPERMILL_EXTRA= (none); unset: $PAPERMILL_DATA/extra.jsonl if present.
inline std::string extra_path() {
    if (const char* v = getenv("PAPERMILL_EXTRA")) return v;
    std::string d = DATA + "/extra.jsonl";
    struct stat st;
    return stat(d.c_str(), &st) == 0 ? d : "";
}
inline bool ends_with(const std::string& a, const char* b) {
    size_t n = strlen(b);
    return a.size() >= n && a.compare(a.size() - n, n, b) == 0;
}
