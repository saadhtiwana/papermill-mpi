// io.hpp - whole-file reads and (multi-member) gzip inflate.
#pragma once
#include "common.hpp"

// ------------------------------------------------------------------ file input
inline std::vector<char> read_file(const std::string& path) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) die("cannot open %s", path.c_str());
    std::vector<char> b;
    struct stat st;
    if (fstat(fileno(f), &st) == 0 && st.st_size > 0) b.resize((size_t)st.st_size);
    size_t n = b.empty() ? 0 : fread(b.data(), 1, b.size(), f);
    fclose(f);
    b.resize(n);
    return b;
}

inline std::vector<char> gunzip(const std::vector<char>& in, const std::string& path) {
    std::vector<char> out(std::max<size_t>(in.size() * 4, 1 << 16));
    z_stream z{};
    if (inflateInit2(&z, 15 + 32) != Z_OK) die("inflateInit2");
    z.next_in = (Bytef*)in.data();
    z.avail_in = (uInt)in.size();
    size_t have = 0;
    while (true) {
        if (have == out.size()) out.resize(out.size() * 3 / 2);
        z.next_out = (Bytef*)out.data() + have;
        z.avail_out = (uInt)(out.size() - have);
        int r = inflate(&z, Z_NO_FLUSH);
        have = out.size() - z.avail_out;
        if (r == Z_STREAM_END) {
            if (z.avail_in == 0) break;
            inflateReset(&z);  // concatenated gzip members
        } else if (r != Z_OK && r != Z_BUF_ERROR) {
            die("corrupt gzip %s (%d)", path.c_str(), r);
        } else if (r == Z_BUF_ERROR && z.avail_in == 0 && z.avail_out != 0) {
            die("truncated gzip %s", path.c_str());
        }
    }
    inflateEnd(&z);
    out.resize(have);
    return out;
}

