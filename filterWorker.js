// filterWorker.js
let allSongsData = [];
let originalOrderMap = new Map(); // To preserve original index for stable sort in case of ties

self.onmessage = function(event) {
    if (event.data.type === 'load') {
        allSongsData = event.data.songs.map((song, index) => {
            originalOrderMap.set(song, index); // Store original index
            return {
                ...song,
                // Ensure all key properties are strings and handle potential null/undefined
                TitleAndArtist: String(song.TitleAndArtist || "Unknown Title"),
                _lowerTitleAndArtist: String(song.TitleAndArtist || "Unknown Title").toLowerCase(),
                SongCode: String(song.SongCode || "N/A"),
                DateString: String(song.DateString || "N/A")
            };
        });
        // Initial sort (example: by DateString descending, then by original order for stability)
        // You might want to sort by TitleAndArtist by default or another field.
        allSongsData.sort((a, b) => {
            // Example: Sort by DateString descending, then TitleAndArtist ascending
            // Assuming DateString is like 'yymmdd' or can be compared lexicographically for recency
            if (a.DateString > b.DateString) return -1;
            if (a.DateString < b.DateString) return 1;
            if (a.TitleAndArtist < b.TitleAndArtist) return -1;
            if (a.TitleAndArtist > b.TitleAndArtist) return 1;
            return originalOrderMap.get(a) - originalOrderMap.get(b); // Fallback to original order
        });
        self.postMessage({ type: 'loaded', totalSongs: allSongsData.length });

    } else if (event.data.type === 'filter') {
        const searchTerm = event.data.term.toLowerCase().trim();

        let filtered;
        if (!searchTerm) {
            filtered = allSongsData; // Return all songs if search is empty, already sorted
        } else {
            filtered = allSongsData.filter(song =>
                song._lowerTitleAndArtist.includes(searchTerm)
            );
            // The filtered list retains the sort order from allSongsData
        }
        self.postMessage({ type: 'results', songs: filtered });
    }
};