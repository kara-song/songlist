// script.js
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const songListBody = document.getElementById('songList');
    const songCountElement = document.getElementById('songCount');
    let songWorker;
    let debounceTimer;

    const MAX_DISPLAY_ITEMS = 450; // Max items to render in the table

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
                    renderSongList(event.data.songs); // songs here is the filtered (and already sorted) list
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
            // Implement a non-worker fallback if absolutely necessary,
            // but most modern browsers support Web Workers.
            // For now, we'll just disable search if no worker.
            searchInput.disabled = true;
        }
    }

    // --- 2. Render Song List in the Table (handles MAX_DISPLAY_ITEMS) ---
    function renderSongList(filteredSongs) {
        songListBody.innerHTML = ''; // Clear existing rows

        const totalMatches = filteredSongs.length;

        if (totalMatches === 0) {
            songListBody.innerHTML = `<tr><td colspan="3">No songs found.</td></tr>`;
            updateSongCount(0, 0);
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
            titleCell.textContent = song.TitleAndArtist;

            const codeCell = document.createElement('td');
            codeCell.textContent = song.SongCode;
            codeCell.classList.add('song-code-cell');

            row.appendChild(dateCell);
            row.appendChild(titleCell);
            row.appendChild(codeCell);
            fragment.appendChild(row);
        });
        songListBody.appendChild(fragment);
        updateSongCount(itemsToDisplay.length, totalMatches);
    }

    // --- 3. Update Song Count ---
    function updateSongCount(displayedCount, totalMatchingCount) {
        if (totalMatchingCount === 0) {
            songCountElement.textContent = "No songs match your search.";
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