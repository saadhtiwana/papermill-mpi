// engine.cpp - papermill-mpi: distributed TF-IDF search engine, MPI + OpenMP, C++17.
//
//   engine index <shard numbers...>      build the index from those shards (+ the optional extra documents)
//   engine search "<query>"              top-10 "id score" from the last index
//   engine collisions K <shards...>      debug: exact 64-bit hash collision check in K hash-range passes
//
// Paths and knobs come from PAPERMILL_* environment variables (README, "Configuration"); default root /data.
// Design:
//   * shards are split round-robin over ranks; extra-docs line j goes to rank j % P
//   * inside a rank, files are inflated in parallel, split into ~1 MB line chunks, and tokenised in parallel;
//     every thread scatters (feature hash, doc, count) postings into 256 buckets keyed by the top hash bits
//   * each bucket is sorted by hash (parallel over buckets) -> per-rank inverted lists + local df
//   * global N by MPI_Allreduce; global df: every feature has an owner rank (hash % P); local dfs are sent to the
//     owner with MPI_Alltoallv, summed, and sent back with a second Alltoallv
//   * each rank writes its own index part on its own node
//   * search: each rank scores its own docs, keeps a local top-10, rank 0 gathers and merges
#include "common.hpp"
#include "io.hpp"
#include "settings.hpp"
#include "tokenize.hpp"

// ------------------------------------------------------------------ index build
// Compact posting (12 bytes, fits L on an 8 GB node): dc = doc << 8 | min(count, 255).
// Counts >= 255 are rare; their exact value lives in a sorted side table (BigCnt) keyed by (hash, doc).
#pragma pack(push, 4)
struct Post { u64 h; u32 dc; };
#pragma pack(pop)
static_assert(sizeof(Post) == 12, "compact posting");
static constexpr u32 MAXDOC = 1u << 24, CSAT = 255;
static inline u32 pdoc(const Post& p) { return p.dc >> 8; }
struct BigCnt {
    u64 h; u32 doc, cnt;
    bool operator<(const BigCnt& o) const { return h < o.h || (h == o.h && doc < o.doc); }
};
static std::vector<BigCnt> BIG;  // merged, sorted side table of saturated counts
static inline u32 pcnt(const Post& p) {
    u32 c = p.dc & 0xFF;
    if (c < CSAT) return c;
    auto it = std::lower_bound(BIG.begin(), BIG.end(), BigCnt{p.h, pdoc(p), 0});
    return it->cnt;
}

static constexpr int NBITS = 8, NB = 1 << NBITS;   // 256 radix buckets by the top hash bits
static constexpr u32 BLK = 1024;                   // postings per storage block

struct ThreadStore {
    std::vector<Post*> blocks[NB];
    u32 fill[NB];
    unsigned lo = 0, hi = NB;  // bucket range kept in the current hash-range pass
    std::vector<BigCnt> big;
    ThreadStore() { std::fill(fill, fill + NB, BLK); }
    inline void push(u64 h, u32 doc, u32 cnt) {
        unsigned b = (unsigned)(h >> (64 - NBITS));
        if (b < lo || b >= hi) return;
        if (fill[b] == BLK) { blocks[b].push_back((Post*)std::malloc(sizeof(Post) * BLK)); fill[b] = 0; }
        if (cnt >= CSAT) big.push_back(BigCnt{h, doc, cnt});
        blocks[b].back()[fill[b]++] = Post{h, doc << 8 | std::min(cnt, CSAT)};
    }
};

struct Unit { std::string path; bool gz, extra; };

struct Chunk {
    int unit;
    const uc *b, *e;
    u32 ndocs = 0;
    u64 doc0 = 0;
    std::string ids;
    std::vector<u32> idlen, maxc;
};

struct Bucket {
    Post* posts = nullptr;
    size_t n = 0;
    std::vector<u64> th;     // unique hashes (sorted)
    std::vector<u32> start;  // first posting of each term (+ sentinel)
    std::vector<u32> df;     // local df
};

struct Progress {
    int last = -1;
    void put(int v) {
        if (RANK != 0) return;
        v = std::max(0, std::min(100, v));
        if (v <= last) return;
        last = v;
        printf("%d\n", v);
        fflush(stdout);
    }
};

static std::string part_path(int r) {
    char b[64];
    snprintf(b, sizeof b, "/part-%04d.bin", r);
    return index_dir() + b;
}

static void clear_index_dir() {
    std::string dir = index_dir();
    mkdir(dir.c_str(), 0775);
    if (DIR* d = opendir(dir.c_str())) {
        while (dirent* de = readdir(d)) {
            if (de->d_name[0] == '.') continue;
            unlink((dir + "/" + de->d_name).c_str());  // several ranks per node may race: ENOENT is fine
        }
        closedir(d);
    }
}

// Index part layout: Header | postings (u32 doc, u32 count)[npost] | term_h u64[nterms] | term_off u64[nterms+1] |
// doc_norm f64[ndocs] | id_off u64[ndocs+1] | term_df u32[nterms] | doc_maxc u32[ndocs] | ids char[ids_bytes]
// Postings come first so each hash-range pass can stream its postings straight to disk.
struct Header {
    char magic[8];
    u64 run_id, N, ndocs, nterms, npost, ids_bytes;
    u32 P, rank;
};

// Number of hash-range passes so that this rank's postings fit in RAM: ~8 bytes of peak memory per compressed input
// byte (measured on a 20-shard run: 928 MiB peak for 97 MB of .gz), against 60% of MemAvailable shared by the ranks
// on this node. PAPERMILL_PASSES=n forces n (tests). The result does not depend on the number of passes.
static int choose_passes(const std::vector<Unit>& units) {
    if (const char* e = getenv("PAPERMILL_PASSES")) if (*e) return std::max(1, std::min(64, std::atoi(e)));
    u64 bytes = 0;
    for (auto& u : units) { struct stat st; if (stat(u.path.c_str(), &st) == 0) bytes += (u64)st.st_size * (u.gz ? 1 : 0); }
    MPI_Comm local;
    MPI_Comm_split_type(MPI_COMM_WORLD, MPI_COMM_TYPE_SHARED, 0, MPI_INFO_NULL, &local);
    int lsz = 1;
    MPI_Comm_size(local, &lsz);
    MPI_Comm_free(&local);
    u64 avail_kb = 0;
    std::ifstream mi("/proc/meminfo");
    std::string k;
    while (mi >> k) { if (k == "MemAvailable:") { mi >> avail_kb; break; } mi.ignore(1 << 10, '\n'); }
    if (avail_kb == 0) return 1;
    double need = 8.0 * (double)bytes, budget = 0.6 * (double)avail_kb * 1024.0 / lsz;
    return std::max(1, std::min(16, (int)std::ceil(need / budget)));
}

static int cmd_index(const std::vector<int>& shards) {
    double t0 = now();
    Progress prog;
    prog.put(0);
    Settings S = load_settings();
    const int T = omp_get_max_threads();

    // run id (stale-index check at search time) + delete the old index on every node before anything else
    u64 run_id = 0;
    if (RANK == 0) run_id = (u64)std::chrono::system_clock::now().time_since_epoch().count() ^ ((u64)getpid() << 32);
    MPI_Bcast(&run_id, 1, MPI_UINT64_T, 0, MPI_COMM_WORLD);
    clear_index_dir();
    MPI_Barrier(MPI_COMM_WORLD);

    // data partitioning: shard i of the command line -> rank i % P; extra-docs line j -> rank j % P
    std::vector<Unit> units;
    for (size_t i = 0; i < shards.size(); ++i)
        if ((int)(i % NP) == RANK) {
            std::string p = shard_path(shards[i]);
            units.push_back({p, ends_with(p, ".gz"), false});
        }
    const std::string extra = extra_path();
    if (!extra.empty()) units.push_back({extra, ends_with(extra, ".gz"), true});
    const int passes = choose_passes(units);
    logr0("P=%d T=%d shards=%zu rank0 units=%zu rank0 passes=%d", NP, T, shards.size(), units.size(), passes);

    std::string path = part_path(RANK), tmp = path + ".tmp";
    FILE* f = fopen(tmp.c_str(), "w+b");
    if (!f) die("cannot write %s", tmp.c_str());
    std::vector<char> iobuf(1 << 22);
    setvbuf(f, iobuf.data(), _IOFBF, iobuf.size());
    Header H{};
    fwrite(&H, sizeof H, 1, f);  // placeholder, rewritten at the end

    std::vector<ThreadStore> stores(T);
    std::string all_ids;
    std::vector<u64> id_off{0};
    std::vector<u32> doc_maxc;
    std::vector<u64> term_h, term_off;  // over all passes, ascending hash
    std::vector<u32> term_df;
    u64 ndocs = 0, npost = 0;
    const size_t batch = (size_t)std::max(2 * T, 4);
    const size_t CHUNK = 1 << 20;
    double t_inflate = 0, t_parse = 0, t_sort = 0, t_wpost = 0;
    size_t nbig = 0;

    for (int pass = 0; pass < passes; ++pass) {
        const unsigned lo = (unsigned)(pass * NB / passes), hi = (unsigned)((pass + 1) * NB / passes);
        for (auto& ts : stores) { ts.lo = lo; ts.hi = hi; }
        const double total_units = (double)units.size();
        double done_units = 0;
        u64 pdocs = 0;  // doc ids are re-derived identically in every pass
        auto pct = [&](double frac) { return 1 + (int)(78.0 * (pass + frac) / passes); };
        for (size_t ub = 0; ub < units.size(); ub += batch) {
            size_t ue = std::min(units.size(), ub + batch);
            std::vector<std::vector<char>> buf(ue - ub);
            double ta = now();
            // (1) read + inflate the files of this batch in parallel (one file per thread at a time)
#pragma omp parallel for schedule(dynamic, 1)
            for (size_t u = ub; u < ue; ++u) {
                std::vector<char> raw = read_file(units[u].path);
                buf[u - ub] = units[u].gz ? gunzip(raw, units[u].path) : std::move(raw);
#pragma omp critical(progress)
                {
                    done_units += 0.25;
                    prog.put(pct(done_units / total_units));
                }
            }
            double tb = now();
            t_inflate += tb - ta;
            // (2) split into ~1 MB chunks at line boundaries
            std::vector<Chunk> chunks;
            for (size_t u = ub; u < ue; ++u) {
                const uc* p = (const uc*)buf[u - ub].data();
                const uc* e = p + buf[u - ub].size();
                if (units[u].extra) { chunks.push_back(Chunk{(int)u, p, e}); continue; }
                while (p < e) {
                    const uc* q = p + std::min<size_t>(CHUNK, (size_t)(e - p));
                    if (q < e) { q = (const uc*)memchr(q, '\n', (size_t)(e - q)); q = q ? q + 1 : e; }
                    chunks.push_back(Chunk{(int)u, p, q});
                    p = q;
                }
            }
            // (3) count docs per chunk (extra docs: keep line j iff j % P == rank), then give each chunk its first doc id
#pragma omp parallel for schedule(dynamic, 1)
            for (size_t c = 0; c < chunks.size(); ++c) {
                Chunk& ch = chunks[c];
                u32 n = 0, line = 0;
                for (const uc* p = ch.b; p < ch.e;) {
                    const uc* q = (const uc*)memchr(p, '\n', (size_t)(ch.e - p));
                    if (!q) q = ch.e;
                    if (skip_ws(p, q) < q) {
                        if (!units[ch.unit].extra || (int)(line % NP) == RANK) ++n;
                        ++line;
                    }
                    p = q + 1;
                }
                ch.ndocs = n;
            }
            for (auto& ch : chunks) { ch.doc0 = pdocs; pdocs += ch.ndocs; }
            if (pdocs >= MAXDOC) die("more than %u docs on one rank (compact postings)", MAXDOC);
            // (4) tokenise every chunk in parallel; postings of this pass's hash range go to the thread's buckets
#pragma omp parallel
            {
                ThreadStore& ts = stores[omp_get_thread_num()];
                std::vector<u64> feats;
                FeatSink sink(S, feats);
                std::string id;
#pragma omp for schedule(dynamic, 1)
                for (size_t c = 0; c < chunks.size(); ++c) {
                    Chunk& ch = chunks[c];
                    const bool can = units[ch.unit].extra;
                    u32 line = 0, doc = 0;
                    for (const uc* p = ch.b; p < ch.e;) {
                        const uc* q = (const uc*)memchr(p, '\n', (size_t)(ch.e - p));
                        if (!q) q = ch.e;
                        if (skip_ws(p, q) < q) {
                            bool mine = !can || (int)(line % NP) == RANK;
                            ++line;
                            if (mine) {
                                feats.clear();
                                if (!parse_doc(p, q, sink, id)) die("bad JSON line in %s", units[ch.unit].path.c_str());
                                std::sort(feats.begin(), feats.end());
                                u32 maxc = 0;
                                const u32 d = (u32)(ch.doc0 + doc);
                                for (size_t i = 0; i < feats.size();) {
                                    size_t j = i + 1;
                                    while (j < feats.size() && feats[j] == feats[i]) ++j;
                                    ts.push(feats[i], d, (u32)(j - i));
                                    maxc = std::max(maxc, (u32)(j - i));
                                    i = j;
                                }
                                if (pass == 0) {
                                    ch.ids += id;
                                    ch.idlen.push_back((u32)id.size());
                                    ch.maxc.push_back(maxc);
                                }
                                ++doc;
                            }
                        }
                        p = q + 1;
                    }
#pragma omp critical(progress)
                    {
                        done_units += 0.75 * (double)(ch.e - ch.b) / (double)std::max<size_t>(1, buf[ch.unit - ub].size());
                        prog.put(pct(done_units / total_units));
                    }
                }
            }
            // (5) append the chunks' doc tables in doc-id order (first pass only)
            if (pass == 0)
                for (auto& ch : chunks) {
                    all_ids += ch.ids;
                    for (u32 l : ch.idlen) id_off.push_back(id_off.back() + l);
                    doc_maxc.insert(doc_maxc.end(), ch.maxc.begin(), ch.maxc.end());
                }
            t_parse += now() - tb;
        }
        if (pass == 0) ndocs = pdocs;
        for (auto& ts : stores) { BIG.insert(BIG.end(), ts.big.begin(), ts.big.end()); std::vector<BigCnt>().swap(ts.big); }
        std::sort(BIG.begin(), BIG.end());
        nbig += BIG.size();
        double t1 = now();

        // (6) per bucket of this pass: gather the threads' blocks, sort by hash, find the terms (parallel over buckets)
        std::vector<Bucket> bk(hi - lo);
#pragma omp parallel for schedule(dynamic, 1)
        for (int b = (int)lo; b < (int)hi; ++b) {
            size_t n = 0;
            for (int t = 0; t < T; ++t)
                if (!stores[t].blocks[b].empty()) n += (stores[t].blocks[b].size() - 1) * BLK + stores[t].fill[b];
            Bucket& B = bk[b - lo];
            B.n = n;
            B.posts = (Post*)std::malloc(sizeof(Post) * std::max<size_t>(n, 1));
            size_t k = 0;
            for (int t = 0; t < T; ++t) {
                auto& v = stores[t].blocks[b];
                for (size_t i = 0; i < v.size(); ++i) {
                    u32 m = (i + 1 == v.size()) ? stores[t].fill[b] : BLK;
                    std::memcpy(B.posts + k, v[i], sizeof(Post) * m);
                    k += m;
                    std::free(v[i]);
                }
                std::vector<Post*>().swap(v);
                stores[t].fill[b] = BLK;
            }
            std::sort(B.posts, B.posts + n, [](const Post& a, const Post& c) { return a.h < c.h || (a.h == c.h && a.dc < c.dc); });
            for (size_t i = 0; i < n;) {
                size_t j = i + 1;
                while (j < n && B.posts[j].h == B.posts[i].h) ++j;
                B.th.push_back(B.posts[i].h);
                B.start.push_back((u32)i);
                B.df.push_back((u32)(j - i));
                i = j;
            }
            B.start.push_back((u32)n);
        }
        double t2 = now();
        t_sort += t2 - t1;
        // (6b) stream this pass's postings to the part file, keep only the term table in memory
        std::vector<u32> dc;
        for (auto& B : bk) {
            for (size_t i = 0; i < B.th.size(); ++i) term_off.push_back(npost + B.start[i]);
            term_h.insert(term_h.end(), B.th.begin(), B.th.end());
            term_df.insert(term_df.end(), B.df.begin(), B.df.end());
            dc.resize(2 * B.n);
            for (size_t j = 0; j < B.n; ++j) { dc[2 * j] = pdoc(B.posts[j]); dc[2 * j + 1] = pcnt(B.posts[j]); }
            fwrite(dc.data(), sizeof(u32), dc.size(), f);
            npost += B.n;
            std::free(B.posts);
            B.posts = nullptr;
        }
        BIG.clear();
        t_wpost += now() - t2;
        prog.put(pct(1.0));
    }
    const u64 nterms = term_h.size();
    term_off.push_back(npost);
    prog.put(81);
    double t3a = now();

    // (7) global N and global df
    u64 N = 0;
    MPI_Allreduce(&ndocs, &N, 1, MPI_UINT64_T, MPI_SUM, MPI_COMM_WORLD);
    if (NP > 1) {
        struct HD { u64 h; u32 df, pad; };
        MPI_Datatype HDT;
        MPI_Type_contiguous((int)sizeof(HD), MPI_BYTE, &HDT);
        MPI_Type_commit(&HDT);
        std::vector<int> scnt(NP, 0), sdis(NP, 0), rcnt(NP), rdis(NP, 0);
        for (u64 h : term_h) ++scnt[h % NP];
        for (int r = 1; r < NP; ++r) sdis[r] = sdis[r - 1] + scnt[r - 1];
        std::vector<HD> sbuf(nterms);
        {
            std::vector<int> pos(sdis);
            for (size_t i = 0; i < nterms; ++i) sbuf[pos[term_h[i] % NP]++] = HD{term_h[i], term_df[i], 0};
        }
        MPI_Alltoall(scnt.data(), 1, MPI_INT, rcnt.data(), 1, MPI_INT, MPI_COMM_WORLD);
        u64 rtot = rcnt[0];
        for (int r = 1; r < NP; ++r) { rdis[r] = rdis[r - 1] + rcnt[r - 1]; rtot += rcnt[r]; }
        if (rtot > 0x7FFFFFFFULL) die("df exchange too large");
        std::vector<HD> rbuf(rtot);
        MPI_Alltoallv(sbuf.data(), scnt.data(), sdis.data(), HDT, rbuf.data(), rcnt.data(), rdis.data(), HDT, MPI_COMM_WORLD);
        std::vector<HD>().swap(sbuf);
        // owner: k-way merge of the P sorted runs, sum the local dfs, reply with the global df in the same layout
        std::vector<u32> reply(rtot);
        {
            using E = std::pair<u64, int>;
            std::priority_queue<E, std::vector<E>, std::greater<E>> pq;
            std::vector<int> cur(NP);
            for (int r = 0; r < NP; ++r) { cur[r] = rdis[r]; if (rcnt[r]) pq.push({rbuf[cur[r]].h, r}); }
            std::vector<int> same;
            while (!pq.empty()) {
                u64 h = pq.top().first;
                u64 sum = 0;
                same.clear();
                while (!pq.empty() && pq.top().first == h) {
                    int r = pq.top().second;
                    pq.pop();
                    sum += rbuf[cur[r]].df;
                    same.push_back(r);
                }
                for (int r : same) {
                    reply[cur[r]] = (u32)sum;
                    if (++cur[r] < rdis[r] + rcnt[r]) pq.push({rbuf[cur[r]].h, r});
                }
            }
        }
        std::vector<HD>().swap(rbuf);
        std::vector<u32> gdf(nterms);
        MPI_Alltoallv(reply.data(), rcnt.data(), rdis.data(), MPI_UINT32_T, gdf.data(), scnt.data(), sdis.data(), MPI_UINT32_T,
                      MPI_COMM_WORLD);
        std::vector<int> pos(sdis);
        for (size_t i = 0; i < nterms; ++i) term_df[i] = gdf[pos[term_h[i] % NP]++];
        MPI_Type_free(&HDT);
    }
    prog.put(88);
    double t3 = now();

    // (8) document lengths for norm=l2, from the postings already on disk. Each doc's squared weights are summed in
    //     ascending order of value, so docs with the same multiset of weights get bit-identical lengths on every layout.
    std::vector<double> dnorm(ndocs, 1.0);
    if (S.l2) {
        fflush(f);
        const size_t plen = sizeof(Header) + 8 * npost;
        const char* m = (const char*)mmap(nullptr, plen, PROT_READ, MAP_SHARED, fileno(f), 0);
        if (m == MAP_FAILED) die("mmap %s", tmp.c_str());
        const u32* pp = (const u32*)(m + sizeof(Header));
        std::vector<u64> off(ndocs + 1, 0);
        for (u64 j = 0; j < npost; ++j) ++off[pp[2 * j] + 1];
        for (u64 d = 0; d < ndocs; ++d) off[d + 1] += off[d];
        std::vector<double> w2(npost);
        std::vector<u64> pos(off.begin(), off.end() - 1);
        for (u64 i = 0; i < nterms; ++i) {
            double idf = idf_w(S, (double)N, (double)term_df[i]);
            for (u64 j = term_off[i]; j < term_off[i + 1]; ++j) {
                const u32 d = pp[2 * j];
                double w = tf_w(S, pp[2 * j + 1], doc_maxc[d]) * idf;
                w2[pos[d]++] = w * w;
            }
        }
        munmap((void*)m, plen);
#pragma omp parallel for schedule(dynamic, 4096)
        for (u64 d = 0; d < ndocs; ++d) {
            std::sort(w2.begin() + off[d], w2.begin() + off[d + 1]);
            double s = 0;
            for (u64 j = off[d]; j < off[d + 1]; ++j) s += w2[j];
            dnorm[d] = std::sqrt(s);
        }
    }

    // (9) the rest of this rank's part (on its own node), then the real header
    fwrite(term_h.data(), sizeof(u64), nterms, f);
    fwrite(term_off.data(), sizeof(u64), term_off.size(), f);
    fwrite(dnorm.data(), sizeof(double), ndocs, f);
    fwrite(id_off.data(), sizeof(u64), id_off.size(), f);
    fwrite(term_df.data(), sizeof(u32), nterms, f);
    fwrite(doc_maxc.data(), sizeof(u32), doc_maxc.size(), f);
    fwrite(all_ids.data(), 1, all_ids.size(), f);
    std::memcpy(H.magic, "PMIDX02", 8);
    H.run_id = run_id; H.N = N; H.ndocs = ndocs; H.nterms = nterms; H.npost = npost; H.ids_bytes = all_ids.size();
    H.P = (u32)NP; H.rank = (u32)RANK;
    fseek(f, 0, SEEK_SET);
    fwrite(&H, sizeof H, 1, f);
    if (fclose(f) != 0) die("write failed %s", tmp.c_str());
    if (rename(tmp.c_str(), path.c_str()) != 0) die("rename %s", path.c_str());
    prog.put(98);
    double t4 = now();
    u64 tot_post = 0, tot_terms = 0;
    MPI_Reduce(&npost, &tot_post, 1, MPI_UINT64_T, MPI_SUM, 0, MPI_COMM_WORLD);
    MPI_Reduce(&nterms, &tot_terms, 1, MPI_UINT64_T, MPI_SUM, 0, MPI_COMM_WORLD);
    MPI_Barrier(MPI_COMM_WORLD);
    struct rusage ru;
    getrusage(RUSAGE_SELF, &ru);
    long rss = ru.ru_maxrss, maxrss = 0;  // KiB
    MPI_Reduce(&rss, &maxrss, 1, MPI_LONG, MPI_MAX, 0, MPI_COMM_WORLD);
    logr0("N=%llu postings=%llu rank-terms=%llu big-counts=%zu passes=%d | inflate %.2fs parse %.2fs sort %.2fs postwrite %.2fs "
          "df %.2fs write %.2fs total %.2fs | peak RSS (max over ranks) %.0f MiB",
          (unsigned long long)N, (unsigned long long)tot_post, (unsigned long long)tot_terms, nbig, passes, t_inflate, t_parse,
          t_sort, t_wpost, t3 - t3a, t4 - t3, now() - t0, maxrss / 1024.0);
    prog.put(100);
    return 0;
}

// ------------------------------------------------------------------ search
struct Hit { double s; std::string id; };
static bool better(const Hit& a, const Hit& b) { return a.s > b.s || (a.s == b.s && a.id < b.id); }

static int cmd_search(const std::string& q) {
    Settings S = load_settings();
    std::vector<u64> qf;
    {
        FeatSink sink(S, qf);
        tok_plain(q, sink);
    }
    std::sort(qf.begin(), qf.end());
    std::vector<u64> qh;
    std::vector<u32> qc;
    for (size_t i = 0; i < qf.size();) {
        size_t j = i + 1;
        while (j < qf.size() && qf[j] == qf[i]) ++j;
        qh.push_back(qf[i]);
        qc.push_back((u32)(j - i));
        i = j;
    }

    // open + validate this rank's part; all ranks must belong to the same index run
    std::string path = part_path(RANK);
    int fd = open(path.c_str(), O_RDONLY);
    struct stat st{};
    const char* base = nullptr;
    int ok = 1;
    if (fd < 0 || fstat(fd, &st) != 0 || (size_t)st.st_size < sizeof(Header)) ok = 0;
    if (ok) {
        base = (const char*)mmap(nullptr, (size_t)st.st_size, PROT_READ, MAP_SHARED, fd, 0);
        if (base == MAP_FAILED) { base = nullptr; ok = 0; }
    }
    Header H{};
    if (ok) {
        std::memcpy(&H, base, sizeof H);
        if (std::memcmp(H.magic, "PMIDX02", 8) != 0 || (int)H.P != NP || (int)H.rank != RANK) ok = 0;
    }
    u64 rid = H.run_id;
    MPI_Bcast(&rid, 1, MPI_UINT64_T, 0, MPI_COMM_WORLD);
    if (rid != H.run_id) ok = 0;
    int all_ok = 0;
    MPI_Allreduce(&ok, &all_ok, 1, MPI_INT, MPI_MIN, MPI_COMM_WORLD);
    if (!all_ok) {
        if (!ok) fprintf(stderr, "[engine rank %d] no valid index part %s for P=%d (run index first)\n", RANK, path.c_str(), NP);
        MPI_Finalize();
        return 1;
    }
    const char* p = base + sizeof(Header);
    const u32* posts = (const u32*)p; p += 8 * H.npost;
    const u64* term_h = (const u64*)p; p += 8 * H.nterms;
    const u64* term_off = (const u64*)p; p += 8 * (H.nterms + 1);
    const double* dnorm = (const double*)p; p += 8 * H.ndocs;
    const u64* id_off = (const u64*)p; p += 8 * (H.ndocs + 1);
    const u32* term_df = (const u32*)p; p += 4 * H.nterms;
    const u32* maxc = (const u32*)p; p += 4 * H.ndocs;
    const char* ids = p;

    // global df of every query feature: a rank that holds the feature knows its global df, others say 0
    const size_t nq = qh.size();
    std::vector<long long> qidx(nq, -1);
    std::vector<u32> ldf(nq, 0), gdf(nq, 0);
    for (size_t i = 0; i < nq; ++i) {
        const u64* it = std::lower_bound(term_h, term_h + H.nterms, qh[i]);
        if (it != term_h + H.nterms && *it == qh[i]) { qidx[i] = it - term_h; ldf[i] = term_df[qidx[i]]; }
    }
    if (nq) MPI_Allreduce(ldf.data(), gdf.data(), (int)nq, MPI_UINT32_T, MPI_MAX, MPI_COMM_WORLD);
    const double N = (double)H.N;
    std::vector<double> qv(nq, 0.0);
    double qn2 = 0;
    for (size_t i = 0; i < nq; ++i)
        if (gdf[i] > 0) { qv[i] = (double)qc[i] * idf_w(S, N, (double)gdf[i]); qn2 += qv[i] * qv[i]; }
    const double qn = std::sqrt(qn2);

    std::vector<Hit> top;
    if (qn > 0) {
        std::vector<double> sc(H.ndocs, 0.0);
        std::vector<u32> touched;
        for (size_t i = 0; i < nq; ++i) {  // fixed (hash) order -> identical sums on every layout
            if (qidx[i] < 0 || gdf[i] == 0) continue;
            const double qq = qv[i] / qn, idf = idf_w(S, N, (double)gdf[i]);
            for (u64 j = term_off[qidx[i]]; j < term_off[qidx[i] + 1]; ++j) {
                u32 d = posts[2 * j], c = posts[2 * j + 1];
                double w = tf_w(S, c, maxc[d]) * idf;
                if (S.l2) w = w / dnorm[d];
                if (sc[d] == 0.0) touched.push_back(d);
                sc[d] += qq * w;
            }
        }
        std::vector<Hit> cand;
        for (u32 d : touched)
            if (sc[d] > 0) cand.push_back({sc[d], std::string(ids + id_off[d], id_off[d + 1] - id_off[d])});
        size_t k = std::min<size_t>(10, cand.size());
        std::partial_sort(cand.begin(), cand.begin() + k, cand.end(), better);
        cand.resize(k);
        top = std::move(cand);
    }

    // rank 0 gathers every rank's local top-10 and merges
    std::string out;
    for (auto& h : top) {
        u32 l = (u32)h.id.size();
        out.append((const char*)&h.s, 8);
        out.append((const char*)&l, 4);
        out += h.id;
    }
    int len = (int)out.size();
    std::vector<int> lens(NP), dis(NP, 0);
    MPI_Gather(&len, 1, MPI_INT, lens.data(), 1, MPI_INT, 0, MPI_COMM_WORLD);
    std::string all;
    if (RANK == 0) {
        for (int r = 1; r < NP; ++r) dis[r] = dis[r - 1] + lens[r - 1];
        all.resize((size_t)(dis[NP - 1] + lens[NP - 1]));
    }
    MPI_Gatherv(out.data(), len, MPI_CHAR, all.data(), lens.data(), dis.data(), MPI_CHAR, 0, MPI_COMM_WORLD);
    if (RANK == 0) {
        std::vector<Hit> m;
        for (size_t i = 0; i + 12 <= all.size();) {
            Hit h;
            u32 l;
            std::memcpy(&h.s, all.data() + i, 8);
            std::memcpy(&l, all.data() + i + 8, 4);
            h.id.assign(all.data() + i + 12, l);
            i += 12 + l;
            m.push_back(std::move(h));
        }
        std::sort(m.begin(), m.end(), better);
        for (size_t i = 0; i < m.size() && i < 10; ++i) printf("%s %.12g\n", m[i].id.c_str(), m[i].s);
        fflush(stdout);
    }
    munmap((void*)base, (size_t)st.st_size);
    close(fd);
    return 0;
}

// ------------------------------------------------------------------ debug: exact hash-collision check
// engine collisions K <shards...> : K passes, pass k keeps features with (h >> 32) % K == k and stores their text;
// two different texts with the same 64-bit hash = a collision. Single process, OpenMP over files.
static int cmd_collisions(int K, const std::vector<int>& shards) {
    Settings S = load_settings();
    std::vector<std::string> files;
    for (int s : shards) files.push_back(shard_path(s));
    if (!extra_path().empty()) files.push_back(extra_path());
    const int T = omp_get_max_threads();
    u64 distinct = 0, collisions = 0;
    for (int k = 0; k < K; ++k) {
        double t0 = now();
        std::vector<std::unordered_map<u64, std::string>> maps(T);
        u64 col = 0;
#pragma omp parallel for schedule(dynamic, 1) reduction(+ : col)
        for (size_t f = 0; f < files.size(); ++f) {
            auto& m = maps[omp_get_thread_num()];
            std::vector<char> raw = read_file(files[f]);
            std::vector<char> buf = files[f].size() > 3 && files[f].compare(files[f].size() - 3, 3, ".gz") == 0 ? gunzip(raw, files[f]) : std::move(raw);
            std::vector<u64> feats;
            std::vector<std::string> strs;
            FeatSink sink(S, feats);
            sink.strs = &strs;
            std::string id;
            const uc* p = (const uc*)buf.data();
            const uc* e = p + buf.size();
            while (p < e) {
                const uc* q = (const uc*)memchr(p, '\n', (size_t)(e - p));
                if (!q) q = e;
                if (skip_ws(p, q) < q) {
                    feats.clear(); strs.clear();
                    parse_doc(p, q, sink, id);
                    for (size_t i = 0; i < feats.size(); ++i) {
                        if ((int)((feats[i] >> 32) % (u64)K) != k) continue;
                        auto r = m.try_emplace(feats[i], strs[i]);
                        if (!r.second && r.first->second != strs[i]) {
                            ++col;
                            fprintf(stderr, "COLLISION %016llx '%s' vs '%s'\n", (unsigned long long)feats[i], r.first->second.c_str(), strs[i].c_str());
                            r.first->second = strs[i];
                        }
                    }
                }
                p = q + 1;
            }
        }
        for (int t = 1; t < T; ++t)
            for (auto& kv : maps[t]) {
                auto r = maps[0].try_emplace(kv.first, kv.second);
                if (!r.second && r.first->second != kv.second) {
                    ++col;
                    fprintf(stderr, "COLLISION %016llx '%s' vs '%s'\n", (unsigned long long)kv.first, r.first->second.c_str(), kv.second.c_str());
                }
            }
        distinct += maps[0].size();
        collisions += col;
        struct rusage ru;
        getrusage(RUSAGE_SELF, &ru);
        printf("pass %d/%d: distinct %zu collisions %llu (%.1fs, peak RSS %.0f MiB)\n", k + 1, K, maps[0].size(), (unsigned long long)col,
               now() - t0, ru.ru_maxrss / 1024.0);
        fflush(stdout);
    }
    printf("TOTAL distinct features %llu, hash collisions %llu\n", (unsigned long long)distinct, (unsigned long long)collisions);
    return 0;
}

int main(int argc, char** argv) {
    // Started without mpirun (a singleton): OpenMPI 4.1 would fork an orted helper and keep two runtime threads in
    // this process. "Isolated" singleton init skips the orted, leaving only ORTE's progress thread (compiled in).
    if (!getenv("OMPI_COMM_WORLD_SIZE") && !getenv("PMIX_RANK")) setenv("OMPI_MCA_ess_singleton_isolated", "1", 0);
    int provided = 0;
    MPI_Init_thread(&argc, &argv, MPI_THREAD_FUNNELED, &provided);
    MPI_Comm_rank(MPI_COMM_WORLD, &RANK);
    MPI_Comm_size(MPI_COMM_WORLD, &NP);
    if (const char* d = getenv("PAPERMILL_DATA")) if (*d) DATA = d;
    int rc = 2;
    std::string cmd = argc > 1 ? argv[1] : "";
    if (cmd == "index") {
        std::vector<int> shards;
        for (int i = 2; i < argc; ++i) {
            char* e = nullptr;
            long v = std::strtol(argv[i], &e, 10);
            if (!e || *e || v < 0 || v > 999) die("bad shard number '%s'", argv[i]);
            shards.push_back((int)v);
        }
        rc = cmd_index(shards);
    } else if (cmd == "collisions" && argc > 2) {
        std::vector<int> shards;
        for (int i = 3; i < argc; ++i) shards.push_back(std::atoi(argv[i]));
        rc = cmd_collisions(std::max(1, std::atoi(argv[2])), shards);
    } else if (cmd == "search") {
        std::string q;
        for (int i = 2; i < argc; ++i) { if (i > 2) q += ' '; q += argv[i]; }
        rc = cmd_search(q);
        if (rc != 0) return rc;  // MPI already finalised
    } else {
        if (RANK == 0) fprintf(stderr, "usage: engine index <shard numbers...> | engine search \"<query>\" | engine collisions K <shards...>\n");
    }
    MPI_Finalize();
    return rc;
}
