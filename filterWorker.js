// filterWorker.js
let allSongsData = [];

// Strip accents/diacritics and fold full-width characters to their plain form.
function normalize(str) {
    return String(str)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

self.onmessage = function(event) {
    if (event.data.type === 'load') {
        allSongsData = event.data.songs.map((song, index) => {
            const titleAndArtist = String(song.TitleAndArtist || "Unknown Title");
            const songCode = String(song.SongCode || "N/A");
            return {
                ...song,
                TitleAndArtist: titleAndArtist,
                SongCode: songCode,
                DateString: String(song.DateString || "N/A"),
                _searchText: normalize(titleAndArtist),
                _searchCode: normalize(songCode),
                _words: normalize(titleAndArtist).split(/[\s\-–—_/⧸／().,:|｜【】「」'"!?♬]+/).filter(Boolean),
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

        self.postMessage({ type: 'loaded', totalSongs: allSongsData.length });

    } else if (event.data.type === 'filter') {
        const rawTerm = event.data.term.trim();

        if (!rawTerm) {
            self.postMessage({ type: 'results', songs: allSongsData });
            return;
        }

        const fullTerm = normalize(rawTerm);
        const tokens = fullTerm.split(/\s+/).filter(Boolean);

        const matches = [];
        for (const song of allSongsData) {
            const everyTokenFound = tokens.every(t =>
                song._searchText.includes(t) || song._searchCode.includes(t)
            );
            if (!everyTokenFound) continue;

            matches.push({ song, score: scoreMatch(song, tokens, fullTerm) });
        }

        matches.sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            // Tie-break with the same order the full list already uses.
            if (a.song.DateString !== b.song.DateString) {
                return a.song.DateString > b.song.DateString ? -1 : 1;
            }
            return a.song._originalIndex - b.song._originalIndex;
        });

        self.postMessage({ type: 'results', songs: matches.map(m => m.song) });
    }
};

// Lower score = better match. 0 is exact, 4 is "found it, but buried in the string."
function scoreMatch(song, tokens, fullTerm) {
    const text = song._searchText;

    if (text === fullTerm) return 0;
    if (text.startsWith(fullTerm)) return 1;

    const allTokensStartAWord = tokens.every(t => song._words.some(w => w.startsWith(t)));
    if (allTokensStartAWord) return 2;

    if (song._searchCode.includes(fullTerm)) return 3;

    return 4;
}
