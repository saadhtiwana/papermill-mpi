// settings.hpp - key=value settings (tf, idf, norm, min_token_len, stemming, stoplist) and the weights.
#pragma once
#include "common.hpp"

// ------------------------------------------------------------------ settings
enum { TF_RAW, TF_LOG, TF_AUG };
enum { IDF_PLAIN, IDF_SMOOTH, IDF_BM25 };

struct Settings {
    int tf = TF_LOG, idf = IDF_SMOOTH;
    bool l2 = false, plural_s = false;
    size_t minlen = 1;
    std::vector<std::string> words;           // stoplist storage (never resized after `stop` is built)
    std::unordered_set<std::string_view> stop;
};

inline std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n"), b = s.find_last_not_of(" \t\r\n");
    return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

inline Settings load_settings() {
    Settings S;
    const std::string path = settings_path();
    std::ifstream in(path);
    if (!in) die("cannot open settings file %s", path.c_str());
    std::string line;
    while (std::getline(in, line)) {
        size_t eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string k = trim(line.substr(0, eq)), v = trim(line.substr(eq + 1));
        if (k == "tf") {
            if (v == "raw") S.tf = TF_RAW; else if (v == "log") S.tf = TF_LOG; else if (v == "aug") S.tf = TF_AUG;
            else die("unknown tf=%s", v.c_str());
        } else if (k == "idf") {
            if (v == "plain") S.idf = IDF_PLAIN; else if (v == "smooth") S.idf = IDF_SMOOTH; else if (v == "bm25") S.idf = IDF_BM25;
            else die("unknown idf=%s", v.c_str());
        } else if (k == "norm") {
            if (v == "l2") S.l2 = true; else if (v == "none") S.l2 = false; else die("unknown norm=%s", v.c_str());
        } else if (k == "min_token_len") {
            S.minlen = (size_t)std::max(0L, std::atol(v.c_str()));
        } else if (k == "stemming") {
            if (v == "plural_s") S.plural_s = true; else if (v == "none" || v.empty()) S.plural_s = false;
            else die("unknown stemming=%s", v.c_str());
        } else if (k == "stoplist") {
            size_t i = 0;
            while (i <= v.size()) {
                size_t j = v.find(',', i);
                if (j == std::string::npos) j = v.size();
                std::string w = trim(v.substr(i, j - i));
                if (!w.empty()) S.words.push_back(w);
                i = j + 1;
            }
        }
    }
    for (auto& w : S.words) S.stop.insert(std::string_view(w));
    return S;
}

inline double tf_w(const Settings& S, u32 c, u32 maxc) {
    switch (S.tf) {
        case TF_RAW: return (double)c;
        case TF_LOG: return 1.0 + std::log((double)c);
        default: return 0.5 + 0.5 * (double)c / (double)maxc;
    }
}

inline double idf_w(const Settings& S, double N, double df) {
    switch (S.idf) {
        case IDF_PLAIN: return std::log(N / df);
        case IDF_SMOOTH: return std::log((1.0 + N) / (1.0 + df)) + 1.0;
        default: return std::log(1.0 + (N - df + 0.5) / (df + 0.5));
    }
}

