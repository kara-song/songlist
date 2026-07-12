// filterWorker.js
//
// Search pipeline, in order of what happens to text:
//   1. normalize()      – NFKD fold (full-width→ASCII, half-width kana→full),
//                         strip Latin accents, recompose kana voicing marks,
//                         lowercase, fold katakana→hiragana.
//   2. kanaToRomaji()   – Hepburn-ish romaji for any kana runs, so "inochi"
//                         matches いのち / イノチ. Kanji passes through
//                         unchanged (the exported `Romaji` field covers kanji
//                         when the desktop tool provides it).
//   3. Strict matching  – every query token must appear (substring) in the
//                         song's haystack (title + romaji + song code).
//   4. Fuzzy fallback   – only when strict matching finds nothing: tokens may
//                         match words with 1–2 typos (bounded edit distance).
//
// NOTE: normalize() is duplicated in script.js for match highlighting.
// If you change it here, change it there too.

let allSongsData = [];

// Unique word -> array of song indices (into allSongsData). The fuzzy pass
// runs edit distance against unique words instead of every word of every
// song, which is roughly an order of magnitude less work.
let wordIndex = new Map();

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Katakana (ァ..ヶ) → hiragana. Runs after NFKD, so half-width katakana has
// already been folded to full-width katakana by that point.
function foldKana(str) {
    return str.replace(/[\u30a1-\u30f6]/g,
        c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function normalize(str) {
    return foldKana(
        String(str)
            .normalize('NFKD')                 // full-width → ASCII, ガ → カ+゙
            .replace(/[\u0300-\u036f]/g, '')   // strip Latin accents only
            .normalize('NFC')                  // recompose カ+゙ → ガ
            .toLowerCase()
    );
}

// Word splitter for building the word list used by prefix scoring and fuzzy
// matching. NFKD has already folded ／｜（）！？ etc. to ASCII, but the CJK
// brackets and music symbols below survive normalization, so list them.
const WORD_SPLIT_RE = /[\s\-–—_/⧸().,:;|【】「」『』〈〉《》［\]\[{}'"!?♬♪♫&＆+~〜・×☆★＊*#、。！？…‥]+/;

function splitWords(str) {
    return str.split(WORD_SPLIT_RE).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Kana → romaji (Hepburn-ish). Input is expected to be normalized already,
// i.e. all kana is hiragana. Non-kana characters pass through unchanged.
// ---------------------------------------------------------------------------

const ROMAJI_DIGRAPHS = {
    'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
    'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho', 'しぇ': 'she',
    'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho', 'ちぇ': 'che',
    'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
    'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
    'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
    'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
    'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
    'じゃ': 'ja',  'じゅ': 'ju',  'じょ': 'jo',  'じぇ': 'je',
    'ぢゃ': 'ja',  'ぢゅ': 'ju',  'ぢょ': 'jo',
    'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
    'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo',
    'ふぁ': 'fa',  'ふぃ': 'fi',  'ふぇ': 'fe',  'ふぉ': 'fo', 'ふゅ': 'fyu',
    'ゔぁ': 'va',  'ゔぃ': 'vi',  'ゔぇ': 've',  'ゔぉ': 'vo',
    'てぃ': 'ti',  'でぃ': 'di',  'とぅ': 'tu',  'どぅ': 'du', 'でゅ': 'dyu',
    'うぃ': 'wi',  'うぇ': 'we',  'うぉ': 'wo',
    'つぁ': 'tsa', 'つぃ': 'tsi', 'つぇ': 'tse', 'つぉ': 'tso'
};

const ROMAJI_MONO = {
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
    'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
    'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
    'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
    'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
    'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
    'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
    'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
    'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
    'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
    'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
    'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
    'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
    'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
    'わ': 'wa', 'ゐ': 'i', 'ゑ': 'e', 'を': 'o', 'ん': 'n',
    'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o',
    'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo', 'ゎ': 'wa',
    'ゔ': 'vu'
};

const HAS_HIRAGANA_RE = /[\u3041-\u3096\u309d\u309e\u30fc]/;

function kanaToRomaji(str) {
    if (!HAS_HIRAGANA_RE.test(str)) return str;
    let out = '';
    let sokuon = false; // pending っ doubles the next consonant
    for (let i = 0; i < str.length; ) {
        const ch = str[i];
        if (ch === 'っ') { sokuon = true; i++; continue; }
        if (ch === 'ー') { // long-vowel mark: repeat the previous vowel
            const last = out[out.length - 1];
            if (last && 'aeiou'.includes(last)) out += last;
            i++;
            continue;
        }
        let roma = null;
        const two = str.substr(i, 2);
        if (ROMAJI_DIGRAPHS[two] !== undefined) { roma = ROMAJI_DIGRAPHS[two]; i += 2; }
        else if (ROMAJI_MONO[ch] !== undefined)  { roma = ROMAJI_MONO[ch];  i += 1; }
        if (roma !== null) {
            if (sokuon) {
                out += roma.startsWith('ch') ? 't' : roma[0]; // っち → tchi
                sokuon = false;
            }
            out += roma;
        } else {
            sokuon = false; // っ before a non-kana char: drop it
            out += ch;
            i++;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Boilerplate words that appear in thousands of YouTube karaoke titles.
// Used only for RANKING (a match on a real word beats a match on these),
// never for filtering.
// ---------------------------------------------------------------------------

const BOILERPLATE = new Set([
    'karaoke', 'からおけ', 'instrumental', 'いんすと', 'いんすとぅるめんたる',
    'lyrics', 'lyric', 'romanized', 'romaji', 'romajinized',
    'guide', 'がいど', 'がいどなし', 'がいどめろでぃ', 'がいどめろでぃー',
    'かいとなし', 'noguidemelody', 'melody', 'めろでぃ', 'めろでぃー',
    'version', 'ver', 'official', 'video', 'audio', 'mv', 'pv',
    'off', 'vocal', 'offvocal', 'おふぼーかる', 'こーらす',
    'cover', 'かばー', 'short', 'full', 'tv', 'size', 'さいず',
    'with', 'without', 'no', 'only', 'jp', 'jpop', 'visualizer',
    '歌詞', 'ふりがな', '練習用', 'かし', 'inst'
]);

// ---------------------------------------------------------------------------
// Bounded edit distance (Levenshtein) for the fuzzy fallback.
// Returns the best of: whole-word distance, or distance to any prefix of
// `word` (so a typo'd query token still matches while someone is typing).
// Returns Infinity when the distance exceeds maxDist.
// ---------------------------------------------------------------------------

function boundedFuzzyDistance(token, word, maxDist) {
    const m = token.length;
    const n = word.length;
    if (n < m - maxDist) return Infinity; // word too short to ever match

    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    let best = Infinity;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        let rowMin = i;
        const tc = token.charCodeAt(i - 1);
        for (let j = 1; j <= n; j++) {
            const cost = (tc === word.charCodeAt(j - 1)) ? 0 : 1;
            const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            curr[j] = v;
            if (v < rowMin) rowMin = v;
        }
        if (rowMin > maxDist) return Infinity; // early abandon
        [prev, curr] = [curr, prev];
    }
    // Whole-word distance:
    if (prev[n] < best) best = prev[n];
    // Prefix distance: token vs word[0..j] for j near the token length.
    const lo = Math.max(0, m - maxDist);
    const hi = Math.min(n, m + maxDist);
    for (let j = lo; j <= hi; j++) {
        if (prev[j] < best) best = prev[j];
    }
    return best <= maxDist ? best : Infinity;
}

function maxEditsFor(token) {
    if (token.length <= 2) return 0;
    if (token.length <= 5) return 1;
    return 2;
}

// ---------------------------------------------------------------------------
// Query preparation: each token gets variants (as-typed + romaji of any kana)
// so a kana query also matches romanized titles.
// ---------------------------------------------------------------------------

function tokenVariants(token) {
    const variants = [token];
    const roma = kanaToRomaji(token);
    if (roma !== token) variants.push(roma);
    return variants;
}

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

self.onmessage = function (event) {
    if (event.data.type === 'load') {
        loadSongs(event.data.songs);
    } else if (event.data.type === 'filter') {
        filterSongs(event.data.term);
    }
};

function loadSongs(songs) {
    allSongsData = songs.map((song, index) => {
        const titleAndArtist = String(song.TitleAndArtist || 'Unknown Title');
        const songCode = String(song.SongCode || 'N/A');

        const normTitle = normalize(titleAndArtist);
        const clientRomaji = kanaToRomaji(normTitle);

        // Optional kanji-aware romaji exported by the desktop tool.
        const exportedRomaji = song.Romaji ? normalize(String(song.Romaji)) : null;

        const fields = [normTitle];
        if (clientRomaji !== normTitle) fields.push(clientRomaji);
        if (exportedRomaji && exportedRomaji !== normTitle) fields.push(exportedRomaji);

        const words = new Set();
        for (const f of fields) for (const w of splitWords(f)) words.add(w);

        const normCode = normalize(songCode);

        return {
            DateString: String(song.DateString || 'N/A'),
            SongCode: songCode,
            TitleAndArtist: titleAndArtist,
            _fields: fields,
            _haystack: fields.join('\n') + '\n' + normCode,
            _searchCode: normCode,
            _words: [...words],
            _originalIndex: index
        };
    });

    allSongsData.sort((a, b) => {
        if (a.DateString > b.DateString) return -1;
        if (a.DateString < b.DateString) return 1;
        if (a.TitleAndArtist < b.TitleAndArtist) return -1;
        if (a.TitleAndArtist > b.TitleAndArtist) return 1;
        return a._originalIndex - b._originalIndex;
    });

    // Build the unique-word index AFTER sorting so the stored indices point
    // at the songs' final positions in allSongsData.
    wordIndex = new Map();
    allSongsData.forEach((song, idx) => {
        for (const w of song._words) {
            let list = wordIndex.get(w);
            if (!list) wordIndex.set(w, list = []);
            list.push(idx);
        }
    });

    self.postMessage({ type: 'loaded', totalSongs: allSongsData.length });
}

function filterSongs(rawTerm) {
    const term = String(rawTerm || '').trim();

    if (!term) {
        self.postMessage({ type: 'results', songs: publicSongs(allSongsData), term: '', tokens: [], fuzzy: false });
        return;
    }

    const fullTerm = normalize(term);
    const fullVariants = tokenVariants(fullTerm);
    const tokens = splitOnSpace(fullTerm);
    const variantsPerToken = tokens.map(tokenVariants);

    // ---- Pass 1: strict (every token is a substring somewhere) ----
    let matches = [];
    for (const song of allSongsData) {
        let ok = true;
        for (const variants of variantsPerToken) {
            if (!variants.some(v => song._haystack.includes(v))) { ok = false; break; }
        }
        if (ok) matches.push({ song, score: scoreStrict(song, variantsPerToken, fullVariants), edits: 0 });
    }

    let fuzzy = false;

    // ---- Pass 2: fuzzy fallback, only when strict found nothing ----
    if (matches.length === 0 && fullTerm.length >= 3) {
        fuzzy = true;

        // For each token, map songIdx -> fewest edits, via the unique-word index.
        const tokenMaps = variantsPerToken.map(variants => {
            const map = new Map();
            for (const [word, songIdxs] of wordIndex) {
                let best = Infinity;
                for (const v of variants) {
                    if (word.startsWith(v)) { best = 0; break; }
                    const k = maxEditsFor(v);
                    if (k === 0) continue;
                    const d = boundedFuzzyDistance(v, word, k);
                    if (d < best) best = d;
                }
                if (best === Infinity) continue;
                for (const idx of songIdxs) {
                    const prev = map.get(idx);
                    if (prev === undefined || best < prev) map.set(idx, best);
                }
            }
            return map;
        });

        // Candidates: any song that fuzzy-matched at least one token. Then
        // verify every token matches it (fuzzily via the map, or as a plain
        // substring for mid-word hits the word index can't see).
        const candidates = new Set();
        for (const map of tokenMaps) for (const idx of map.keys()) candidates.add(idx);

        for (const idx of candidates) {
            const song = allSongsData[idx];
            let totalEdits = 0;
            let ok = true;
            for (let i = 0; i < variantsPerToken.length; i++) {
                let edits = tokenMaps[i].get(idx);
                if (edits === undefined) {
                    edits = variantsPerToken[i].some(v => song._haystack.includes(v))
                        ? 0 : Infinity;
                }
                if (edits === Infinity) { ok = false; break; }
                totalEdits += edits;
            }
            if (ok) matches.push({ song, score: 10 + totalEdits, edits: totalEdits });
        }
    }

    matches.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        if (a.song.DateString !== b.song.DateString) {
            return a.song.DateString > b.song.DateString ? -1 : 1;
        }
        return a.song._originalIndex - b.song._originalIndex;
    });

    self.postMessage({
        type: 'results',
        songs: publicSongs(matches.map(m => m.song)),
        term: term,
        tokens: tokens,
        fuzzy: fuzzy
    });
}

function splitOnSpace(str) {
    return str.split(/\s+/).filter(Boolean);
}

// Lower score = better match.
//   0 exact title, 1 title prefix, 2 every token starts a *meaningful* word,
//   3 every token starts a word, 4 song-code hit, 5 substring match anywhere.
function scoreStrict(song, variantsPerToken, fullVariants) {
    for (const fv of fullVariants) {
        if (song._fields.some(f => f === fv)) return 0;
    }
    for (const fv of fullVariants) {
        if (song._fields.some(f => f.startsWith(fv))) return 1;
    }

    const startsWord = variants => song._words.some(
        w => variants.some(v => w.startsWith(v)));
    const startsMeaningfulWord = variants => song._words.some(
        w => !BOILERPLATE.has(w) && variants.some(v => w.startsWith(v)));

    if (variantsPerToken.every(startsMeaningfulWord)) return 2;
    if (variantsPerToken.every(startsWord)) return 3;

    if (fullVariants.some(fv => song._searchCode.includes(fv))) return 4;
    return 5;
}

// Strip the private underscore fields before posting back to the UI thread;
// structured-clone of 43k word arrays on every keystroke is wasted work.
function publicSongs(list) {
    return list.map(s => ({
        DateString: s.DateString,
        SongCode: s.SongCode,
        TitleAndArtist: s.TitleAndArtist
    }));
}
