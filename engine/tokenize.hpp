// tokenize.hpp - text -> features: lower-case [a-z0-9]+ tokens, length + stoplist filter, plural_s,
// unigrams + bigrams, each identified by a 64-bit hash; plus the in-place JSON line parser.
#pragma once
#include "common.hpp"
#include "settings.hpp"

// ------------------------------------------------------------------ tokenizer -> feature hashes
// A feature is identified by a 64-bit hash of its text (bigram text = "a_b"), FNV-1a + splitmix finaliser.
static constexpr u64 FNV_OFF = 1469598103934665603ULL, FNV_PRIME = 1099511628211ULL;
inline u64 mix64(u64 x) {
    x ^= x >> 30; x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27; x *= 0x94d049bb133111ebULL;
    return x ^ (x >> 31);
}

struct FeatSink {  // pipeline: token -> length filter -> stoplist -> plural_s -> unigram + bigram with previous
    const Settings& S;
    std::vector<u64>& out;
    std::string tok;
    u64 prev_raw = 0;
    bool has_prev = false;
    std::vector<std::string>* strs = nullptr;  // debug (collision check) only: feature text, parallel to `out`
    std::string prev_str;
    FeatSink(const Settings& s, std::vector<u64>& o) : S(s), out(o) {}
    void reset() { tok.clear(); has_prev = false; }
    inline void ch(char c) { tok.push_back(c); }
    inline void end() {
        size_t n = tok.size();
        if (n == 0) return;
        if (n >= S.minlen && (S.stop.empty() || !S.stop.count(std::string_view(tok.data(), n)))) {
            if (S.plural_s && n > 3 && tok[n - 1] == 's' && tok[n - 2] != 's') --n;
            u64 r = FNV_OFF;
            for (size_t i = 0; i < n; ++i) r = (r ^ (u8)tok[i]) * FNV_PRIME;
            out.push_back(mix64(r));
            if (has_prev) {
                u64 b = (prev_raw ^ (u8)'_') * FNV_PRIME;
                for (size_t i = 0; i < n; ++i) b = (b ^ (u8)tok[i]) * FNV_PRIME;
                out.push_back(mix64(b));
            }
            if (strs) {
                std::string u(tok.data(), n);
                if (has_prev) strs->push_back(u), strs->push_back(prev_str + "_" + u); else strs->push_back(u);
                prev_str = u;
            }
            prev_raw = r;
            has_prev = true;
        }
        tok.clear();
    }
};

// Same as Python's str.lower() followed by [a-z0-9]+ : only U+212A (Kelvin) and U+0130 (I with dot: "i" + U+0307)
// lower-case into ASCII letters; every other non-ASCII code point separates tokens.
inline void put_cp(FeatSink& f, u32 cp) {
    if (cp < 128) {
        char c = (char)cp;
        if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) f.ch(c); else f.end();
    } else if (cp == 0x212A) {
        f.ch('k');
    } else if (cp == 0x130) {
        f.ch('i');
        f.end();
    } else {
        f.end();
    }
}

inline u32 utf8_next(const uc*& p, const uc* e) {
    u32 c = *p++;
    if (c < 0x80) return c;
    int n;
    u32 cp;
    if ((c & 0xE0) == 0xC0) { n = 1; cp = c & 0x1F; }
    else if ((c & 0xF0) == 0xE0) { n = 2; cp = c & 0x0F; }
    else if ((c & 0xF8) == 0xF0) { n = 3; cp = c & 0x07; }
    else return 0xFFFD;
    for (; n && p < e && (*p & 0xC0) == 0x80; --n) cp = (cp << 6) | (*p++ & 0x3F);
    return n ? 0xFFFD : cp;
}

inline int hexv(uc c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
inline u32 hex4(const uc* p, const uc* e) {
    if (e - p < 4) return 0xFFFD;
    u32 v = 0;
    for (int i = 0; i < 4; ++i) {
        int h = hexv(p[i]);
        if (h < 0) return 0xFFFD;
        v = (v << 4) | (u32)h;
    }
    return v;
}

// JSON \u escape at p (just after "\u"); advances p; handles surrogate pairs.
inline u32 json_u(const uc*& p, const uc* e) {
    u32 cp = hex4(p, e);
    p += std::min<ptrdiff_t>(4, e - p);
    if (cp >= 0xD800 && cp < 0xDC00 && e - p >= 6 && p[0] == '\\' && p[1] == 'u') {
        u32 lo = hex4(p + 2, e);
        if (lo >= 0xDC00 && lo < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); p += 6; }
    }
    return cp;
}

// Tokenise a JSON string body; p is just after the opening quote. Returns the position after the closing quote.
inline const uc* tok_json_str(const uc* p, const uc* e, FeatSink& f) {
    while (p < e) {
        uc c = *p;
        if (c == '"') { f.end(); return p + 1; }
        if (c == '\\') {
            if (p + 1 >= e) break;
            uc x = p[1];
            p += 2;
            if (x == 'u') put_cp(f, json_u(p, e));
            else f.end();  // \" \\ \/ \b \f \n \r \t : none is [a-z0-9]
            continue;
        }
        if (c < 0x80) {
            if (c >= 'a' && c <= 'z') f.ch((char)c);
            else if (c >= '0' && c <= '9') f.ch((char)c);
            else if (c >= 'A' && c <= 'Z') f.ch((char)(c + 32));
            else f.end();
            ++p;
        } else {
            put_cp(f, utf8_next(p, e));
        }
    }
    f.end();
    return p;
}

inline void tok_plain(const std::string& s, FeatSink& f) {
    const uc* p = (const uc*)s.data();
    const uc* e = p + s.size();
    while (p < e) put_cp(f, utf8_next(p, e));
    f.end();
}

inline void put_utf8(std::string& o, u32 cp) {
    if (cp < 0x80) o += (char)cp;
    else if (cp < 0x800) { o += (char)(0xC0 | (cp >> 6)); o += (char)(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { o += (char)(0xE0 | (cp >> 12)); o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F)); }
    else { o += (char)(0xF0 | (cp >> 18)); o += (char)(0x80 | ((cp >> 12) & 0x3F)); o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F)); }
}

inline const uc* dec_json_str(const uc* p, const uc* e, std::string& out) {
    out.clear();
    while (p < e && *p != '"') {
        if (*p == '\\' && p + 1 < e) {
            uc x = p[1];
            p += 2;
            switch (x) {
                case 'u': put_utf8(out, json_u(p, e)); break;
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                default: out += (char)x;
            }
        } else {
            out += (char)*p++;
        }
    }
    return p < e ? p + 1 : p;
}

inline const uc* skip_ws(const uc* p, const uc* e) {
    while (p < e && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) ++p;
    return p;
}

inline const uc* skip_val(const uc* p, const uc* e) {
    int depth = 0;
    while (p < e) {
        uc c = *p;
        if (c == '"') {
            ++p;
            while (p < e && *p != '"') p += (*p == '\\') ? 2 : 1;
            ++p;
            if (depth == 0) return p;
            continue;
        }
        if (c == '{' || c == '[') ++depth;
        else if (c == '}' || c == ']') { if (depth == 0) return p; if (--depth == 0) return p + 1; }
        else if (c == ',' && depth == 0) return p;
        ++p;
    }
    return p;
}

// One JSON line {"id": "...", "text": "..."} (any key order). Text is tokenised in place, never copied.
inline bool parse_doc(const uc* p, const uc* e, FeatSink& sink, std::string& id) {
    id.clear();
    sink.reset();
    p = skip_ws(p, e);
    if (p >= e || *p != '{') return false;
    ++p;
    while (true) {
        p = skip_ws(p, e);
        if (p >= e || *p == '}') break;
        if (*p == ',') { ++p; continue; }
        if (*p != '"') return false;
        const uc* ks = ++p;
        while (p < e && *p != '"') p += (*p == '\\') ? 2 : 1;
        std::string_view key((const char*)ks, (size_t)(p - ks));
        p = skip_ws(p + 1, e);
        if (p >= e || *p != ':') return false;
        p = skip_ws(p + 1, e);
        if (p >= e) break;
        if (key == "text" && *p == '"') p = tok_json_str(p + 1, e, sink);
        else if (key == "id" && *p == '"') p = dec_json_str(p + 1, e, id);
        else if (key == "id") { const uc* s = p; p = skip_val(p, e); id = trim(std::string((const char*)s, (size_t)(p - s))); }
        else p = skip_val(p, e);
    }
    return true;
}

