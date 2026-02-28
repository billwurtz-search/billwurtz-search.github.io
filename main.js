const form = document.getElementById('search-form');
const qInput = document.getElementById('q');
const sortSelect = document.getElementById('sort');
const filterSelect = document.getElementById('filter');
const resultsArea = document.getElementById('results-area');
const countDisplay = document.getElementById('count-display');
const statusMsg = document.getElementById('status-msg');
const sentinel = document.getElementById('sentinel');
const modal = document.getElementById('config-modal');
const configBtn = document.getElementById('config-btn');
const closeModal = document.getElementById('close-modal');
const limitSlider = document.getElementById('limit-slider');
const limitLabel = document.getElementById('limit-label');
const checkLinks = document.getElementById('check-links');
const checkHighlight = document.getElementById('check-highlight');
const checkMoreFilters = document.getElementById('check-more-filters');
const toastElement = document.getElementById('toast');
const toastMessageElement = document.getElementById('toast-message');
const modalBox = document.querySelector('.modal-content');
const checkIndexing = document.getElementById('check-indexing');
let toastTimer = null;

const logFiles = [];
for (let i = 1; i <= 14; i++) {
    const num = i.toString().padStart(2, '0');
    logFiles.push(`logs/log_${num}.json`);
}

let currentResults = [];
let currentOffset = 0;
let currentLimit = 100;
let isDownloading = false;

window.addEventListener('DOMContentLoaded', () => {
    const savedCachePref = localStorage.getItem('bwsearch-cache-pref');
    if (savedCachePref !== null) {
        checkIndexing.checked = (savedCachePref === 'true');
    }

    checkMoreFilters.checked = false;
    
    // check '?q=' permalink
    const urlParams = new URLSearchParams(window.location.search);
    const initialQuery = urlParams.get('q');

    if (initialQuery) {
        qInput.value = initialQuery;
        window.history.replaceState(null, '', window.location.pathname);
        triggerSearch();
    } else {
        qInput.value = '';
        statusMsg.innerText = "Search stuff to search.";
    }
});

form.addEventListener('submit', (e) => {
    e.preventDefault();
    triggerSearch();
});

qInput.addEventListener('keydown', (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        triggerSearch();
    }
});

window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        qInput.focus();
    }
});

// modal
const hideModal = () => {
    modal.style.display = "none";
    configBtn.focus();
};

configBtn.onclick = () => {
    modal.style.display = "block";
    closeModal.focus();
};

closeModal.onclick = hideModal;
window.onclick = (e) => { if (e.target == modal) hideModal(); };

window.addEventListener('keydown', (e) => { 
    if (e.key === "Escape" && modal.style.display === "block") hideModal(); 
});

// checkboxes
limitSlider.oninput = function() {
    limitLabel.innerText = this.value;
    currentLimit = parseInt(this.value);
};

checkLinks.onchange = function() {
    if (this.checked) document.body.classList.remove('disable-links');
    else document.body.classList.add('disable-links');
};

checkHighlight.onchange = function() {
    if (this.checked) document.body.classList.remove('disable-highlight');
    else document.body.classList.add('disable-highlight');
};

checkIndexing.onchange = async function() {
    localStorage.setItem('bwsearch-cache-pref', this.checked);
    if (!this.checked) {
        try {
            await SearchEngine.deleteIndex();
        } catch(e) {}
    }
};

checkMoreFilters.onchange = function() {
    const extraOptions = [
        { val: 'dual-req', txt: 'Must be in Both' },
        { val: 'q-excl', txt: 'Exclusively Ques' },
        { val: 'a-excl', txt: 'Exclusively Answ' },
        { val: 'date-incl', txt: 'Search dates' }
    ];

    if (this.checked) {
        extraOptions.forEach(opt => {
            const el = document.createElement('option');
            el.value = opt.val;
            el.textContent = opt.txt;
            el.className = 'extra-opt';
            filterSelect.appendChild(el);
        });
    } else {
        if (filterSelect.selectedOptions[0]?.classList.contains('extra-opt')) filterSelect.value = 'both';
        document.querySelectorAll('.extra-opt').forEach(el => el.remove());
    }
};

// trigger search
async function triggerSearch() {
    const query = qInput.value.trim();
    if (!query) {
        statusMsg.innerText = "Please enter something to search.";
        return;
    }

if (!SearchEngine.isLoaded) {
        if (isDownloading) return;
        isDownloading = true;

        statusMsg.innerText = "Loading database...";

        let isSlowData = false;
        let hasStartedProgress = false;

        const slowTimer = setTimeout(() => {
            isSlowData = true;
            if (SearchEngine.isLoaded) return;

            if (hasStartedProgress) {
                statusMsg.innerText += " -- this is only slow once.";
            } else {
                statusMsg.innerText = "Loading database... (this is taking a while, huh)";
            }
        }, 10000);

        try {
    await SearchEngine.loadAllData(logFiles, (current, total) => {
                hasStartedProgress = true;
                const loadPercent = Math.round((current / total) * 100);
                const slowSuffix = isSlowData ? " -- this is only slow once." : "";
                statusMsg.innerText = `Loading database (${loadPercent}%)${slowSuffix}`;
            }, checkIndexing.checked);

            const lastItem = SearchEngine.allData[SearchEngine.allData.length - 1];
            if (lastItem && lastItem.date) {
                const rawDate = lastItem.date.split(' ')[0];
                const parts = rawDate.split('.');
                if (parts.length === 3) {
                    const dateEl = document.getElementById('db-date');
                    if (dateEl) {
                        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
                        const monthName = months[parseInt(parts[0], 10) - 1];
                        const dbDay = parseInt(parts[1], 10);
                        dateEl.innerText = `${monthName} ${dbDay}, 20${parts[2]}`;
                    }
                }
            }
        } catch (e) {
            console.error(e);
            statusMsg.innerText = "Error loading database :(";
            isDownloading = false;
            return;
        } finally {
            clearTimeout(slowTimer);
        }
        isDownloading = false;
    }

    // searching
    resultsArea.innerHTML = "";
    countDisplay.innerText = "";
    currentOffset = 0;
    currentResults = [];

    statusMsg.innerText = "Searching...";
    
    const params = {
        query: query,
        sortBy: sortSelect.value,
        searchIn: filterSelect.value
    };

    setTimeout(() => {
        const response = SearchEngine.executeSearch(params);
        if (response.message) {
            statusMsg.innerText = response.message;
            return;
        }
        
        currentResults = response.results;
        const desktopText = `Found ${currentResults.length} results.`;
        const mobileText = `${currentResults.length} results`;
        
        countDisplay.innerText = desktopText;
        
        if (currentResults.length === 0) {
            statusMsg.innerText = "No results found.";
            showToast("0 results");
        } else {
            showToast(mobileText);
            renderBatch();
        }
    }, 10);
}

function renderBatch() {
    if (currentOffset >= currentResults.length) {
        statusMsg.innerText = "End of results.";
        return;
    }
    const nextBatch = currentResults.slice(currentOffset, currentOffset + currentLimit);
    const fragment = document.createDocumentFragment();
    nextBatch.forEach(item => {
        const div = document.createElement('div');
        div.innerHTML = `
            <br><br>
            <h3> 
                <span class="dco"><a href="${item.link}" target="_blank" rel="noopener noreferrer">${item.dateHtml}</a></span> 
                &nbsp;
                <span class="qco">${item.questionHtml}</span> 
            </h3> 
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span class="ans">${item.answerHtml}</span>
        `;
        fragment.appendChild(div);
    });
    resultsArea.appendChild(fragment);
    currentOffset += nextBatch.length;
    statusMsg.innerText = (currentOffset >= currentResults.length) ? "End of results." : "";
}

function showToast(message) {
    if (toastTimer) clearTimeout(toastTimer);
    
    toastMessageElement.textContent = message;
    toastElement.classList.remove('toast-hidden');
    toastElement.classList.add('toast-visible');

    toastTimer = setTimeout(() => {
        toastElement.classList.remove('toast-visible');
        toastElement.classList.add('toast-hidden');
        toastTimer = null;
    }, 3600);
}

const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && currentResults.length > 0 && currentOffset < currentResults.length) {
        renderBatch();
    }
}, { threshold: 0.1 });
observer.observe(sentinel);
