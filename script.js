// script.js
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const songListBody = document.getElementById('songList');
    const songCountElement = document.getElementById('songCount');
    let songWorker;
    let debounceTimer;

    const MAX_DISPLAY_ITEMS = 450; // Max items to render in the table

    // --- 0. Normalization for highlighting -------------------------------
    // Mirrors normalize() in filterWorker.js (keep the two in sync), but is
    // applied per character so we can map positions in the normalized string
    // back to positions in the original title.
    function normalizeCharForSearch(ch) {
        return ch
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .normalize('NFC')
            .toLowerCase()
            .replace(/[\u30a1-\u30f6]/g,
                c => String.fromCharCode(c.charCodeAt(0) - 0x60));
    }

    // Note: characters already stored decomposed in the source data (rare for
    // YouTube titles) may not highlight; the row itself still matches fine.
    function buildNormalizedMap(original) {
        let norm = '';
        const starts = [];
        const ends = [];
        let pos = 0;
        for (const ch of original) { // iterates by code point
            const out = normalizeCharForSearch(ch);
            for (let i = 0; i < out.length; i++) {
                starts.push(pos);
                ends.push(pos + ch.length);
            }
            norm += out;
            pos += ch.length;
        }
        return { norm, starts, ends };
    }

    // Fills `cell` with `originalText`, wrapping parts that match any of the
    // normalized `tokens` in <mark>. Built with DOM nodes, never innerHTML.
    function fillCellWithHighlights(cell, originalText, tokens) {
        if (!tokens || tokens.length === 0) {
            cell.textContent = originalText;
            return;
        }

        const { norm, starts, ends } = buildNormalizedMap(originalText);
        const ranges = [];
        for (const token of tokens) {
            if (!token) continue;
            let idx = 0;
            let guard = 0;
            while ((idx = norm.indexOf(token, idx)) !== -1 && guard++ < 50) {
                ranges.push([starts[idx], ends[idx + token.length - 1]]);
                idx += token.length;
            }
        }

        if (ranges.length === 0) { // e.g. romaji-variant or fuzzy match
            cell.textContent = originalText;
            return;
        }

        // Merge overlapping/adjacent ranges.
        ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const merged = [ranges[0].slice()];
        for (let i = 1; i < ranges.length; i++) {
            const last = merged[merged.length - 1];
            if (ranges[i][0] <= last[1]) {
                last[1] = Math.max(last[1], ranges[i][1]);
            } else {
                merged.push(ranges[i].slice());
            }
        }

        let cursor = 0;
        for (const [s, e] of merged) {
            if (s > cursor) {
                cell.appendChild(document.createTextNode(originalText.slice(cursor, s)));
            }
            const mark = document.createElement('mark');
            mark.textContent = originalText.slice(s, e);
            cell.appendChild(mark);
            cursor = e;
        }
        if (cursor < originalText.length) {
            cell.appendChild(document.createTextNode(originalText.slice(cursor)));
        }
    }

    // --- 1. Initialize Web Worker and Load Initial Data ---
    function initializeWorkerAndLoadSongs() {
        songCountElement.textContent = "Loading songs...";
        searchInput.disabled = true;

        if (window.Worker) {
            songWorker = new Worker('filterWorker.js');

            // Handle messages from the worker
            songWorker.onmessage = function(event) {
                if (event.data.type === 'loaded') {
                    songCountElement.textContent = `Ready. ${event.data.totalSongs} songs loaded. Type to search.`;
                    searchInput.disabled = false;
                    searchInput.focus();
                    // Trigger initial display of all songs (or first page of them)
                    songWorker.postMessage({ type: 'filter', term: '' });
                } else if (event.data.type === 'results') {
                    renderSongList(event.data.songs, event.data.tokens, event.data.fuzzy);
                }
            };

            songWorker.onerror = function(error) {
                console.error("Worker error:", error.message, error);
                songCountElement.textContent = "Error initializing search. Please refresh.";
                searchInput.disabled = true;
            };

            // Fetch JSON and send to worker
            fetch('KaraokeList_Auto.json')
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                    return response.json();
                })
                .then(songs => {
                    songWorker.postMessage({ type: 'load', songs: songs });
                })
                .catch(error => {
                    console.error("Could not load songs.json:", error);
                    songListBody.innerHTML = `<tr><td colspan="3">Error loading song data.</td></tr>`;
                    songCountElement.textContent = "Failed to load song data.";
                    searchInput.disabled = true;
                });

        } else {
            // Fallback if Web Workers are not supported
            console.warn("Web Workers not supported. This may impact performance.");
            songCountElement.textContent = "Web Workers not supported. Search might be slow.";
            searchInput.disabled = true;
        }
    }

    // --- 2. Render Song List in the Table (handles MAX_DISPLAY_ITEMS) ---
    function renderSongList(filteredSongs, tokens, fuzzy) {
        songListBody.innerHTML = ''; // Clear existing rows

        const totalMatches = filteredSongs.length;

        if (totalMatches === 0) {
            songListBody.innerHTML = `<tr><td colspan="3">No songs found.</td></tr>`;
            updateSongCount(0, 0, fuzzy);
            return;
        }

        const fragment = document.createDocumentFragment();
        const itemsToDisplay = filteredSongs.slice(0, MAX_DISPLAY_ITEMS);

        itemsToDisplay.forEach(song => {
            const row = document.createElement('tr');
            row.dataset.songcode = song.SongCode; // Store song code for double-click

            const dateCell = document.createElement('td');
            dateCell.textContent = song.DateString;

            const titleCell = document.createElement('td');
            fillCellWithHighlights(titleCell, song.TitleAndArtist, tokens);

            // Warn when the video shows Japanese-only on-screen lyrics
            // (カラオケ歌っちゃ王). Flagged in the JSON by the desktop tool.
            if (song.JapaneseOnly) {
                const badge = document.createElement('span');
                badge.className = 'jp-only-badge';
                badge.textContent = '⚠ JP LYRICS ONLY';
                badge.title = 'This video shows Japanese lyrics only — no romaji or ' +
                    'English on screen, so non-Japanese readers may not be able to sing along.';
                titleCell.appendChild(document.createTextNode(' '));
                titleCell.appendChild(badge);
            }

            const codeCell = document.createElement('td');
            codeCell.textContent = song.SongCode;
            codeCell.classList.add('song-code-cell');

            // Play link — hidden on desktop (double-click covers it there),
            // shown as a button-style chip on phones via the CSS media query.
            const playCell = document.createElement('td');
            playCell.classList.add('play-cell');
            if (song.SongCode && song.SongCode !== 'N/A') {
                const playLink = document.createElement('a');
                playLink.href = `https://youtu.be/${song.SongCode}`;
                playLink.target = '_blank';
                playLink.rel = 'noopener';
                playLink.textContent = '\u25B6 Play';
                playCell.appendChild(playLink);
            }

            row.appendChild(dateCell);
            row.appendChild(titleCell);
            row.appendChild(codeCell);
            row.appendChild(playCell);
            fragment.appendChild(row);
        });
        songListBody.appendChild(fragment);
        updateSongCount(itemsToDisplay.length, totalMatches, fuzzy);
    }

    // --- 3. Update Song Count ---
    function updateSongCount(displayedCount, totalMatchingCount, fuzzy) {
        if (totalMatchingCount === 0) {
            songCountElement.textContent = fuzzy
                ? "No songs found, even allowing for typos."
                : "No songs match your search.";
        } else if (fuzzy) {
            songCountElement.textContent = totalMatchingCount > displayedCount
                ? `No exact matches — showing ${displayedCount} of ${totalMatchingCount} close matches`
                : `No exact matches — showing ${totalMatchingCount} close ${totalMatchingCount === 1 ? "match" : "matches"}`;
        } else if (totalMatchingCount > displayedCount) {
            songCountElement.textContent = `Showing ${displayedCount} of ${totalMatchingCount} matching songs`;
        } else {
            songCountElement.textContent = `Showing ${displayedCount} matching songs`;
        }
    }

    // --- 4. Search Input Event Listener (with Debounce) ---
    searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (songWorker) {
                const searchTerm = searchInput.value;
                songWorker.postMessage({ type: 'filter', term: searchTerm });
                // Temporary "searching" message. UpdateSongCount will override it.
                if (searchTerm) {
                    songCountElement.textContent = "Searching...";
                }
            }
        }, 300); // Debounce for 300ms (adjust as needed)
    });


    // --- 5. Handle Clicks and Double Clicks on Song List (Event Delegation) ---
    songListBody.addEventListener('click', (event) => {
        const targetCell = event.target.closest('td');
        if (!targetCell) return;

        const songCode = targetCell.parentElement.dataset.songcode;

        if (targetCell.classList.contains('song-code-cell')) {
            if (songCode && songCode !== "N/A") {
                copyToClipboard(songCode);
            }
        }
    });

    songListBody.addEventListener('dblclick', (event) => {
        const targetRow = event.target.closest('tr');
        if (!targetRow) return;

        const songCode = targetRow.dataset.songcode;
        if (songCode && songCode !== "N/A") {
            window.open(`https://youtu.be/${songCode}`, '_blank');
        }
    });

    // --- 6. Copy to Clipboard Function ---
    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            showCopiedFeedback();
        }).catch(err => {
            console.error('Failed to copy: ', err);
            try { // Fallback
                const textArea = document.createElement("textarea");
                textArea.value = text;
                textArea.style.position = "fixed"; // Prevent scrolling to bottom
                textArea.style.opacity = "0";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                showCopiedFeedback();
            } catch (fallbackErr) {
                alert('Failed to copy SongCode. Please copy it manually.');
            }
        });
    }

    // --- 7. Show "Copied!" Feedback ---
    function showCopiedFeedback() {
        let feedbackDiv = document.querySelector('.copied-feedback');
        if (!feedbackDiv) {
            feedbackDiv = document.createElement('div');
            feedbackDiv.className = 'copied-feedback';
            feedbackDiv.textContent = 'SongCode Copied!';
            document.body.appendChild(feedbackDiv);
        }
        feedbackDiv.classList.add('show');
        setTimeout(() => {
            feedbackDiv.classList.remove('show');
        }, 1500);
    }

    // --- Initial Setup ---
    initializeWorkerAndLoadSongs();
});
