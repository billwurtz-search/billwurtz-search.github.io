const LOG_FILES = [];
for (let i = 1; i <= 14; i++) {
    const num = i.toString().padStart(2, '0');
    LOG_FILES.push(`logs/log_${num}.json`);
}

let currentResults = [];
let currentOffset = 0;
let currentLimit = 100;
let isDownloading = false;

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
const checkRegex = document.getElementById('check-regex');
const checkMoreFilters = document.getElementById('check-more-filters');
const toastElement = document.getElementById('toast');
const toastMessageElement = document.getElementById('toast-message');
const modalBox = document.querySelector('.modal-content');
let toastTimer = null;

window.addEventListener('DOMContentLoaded', () => {
    checkMoreFilters.checked = false; 
    qInput.value = '';
    statusMsg.innerText = "Search stuff to search.";
});

form.addEventListener('submit', (e) => {
    e.preventDefault();
    triggerSearch();
});

configBtn.onclick = () => modal.style.display = "block";
closeModal.onclick = () => modal.style.display = "none";
window.onclick = (e) => { if (e.target == modal) modal.style.display = "none"; };
window.addEventListener('keydown', (e) => { if (e.key === "Escape") modal.style.display = "none"; });

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

checkRegex.onchange = function() { if (qInput.value.trim()) triggerSearch(); };

checkMoreFilters.onchange = function() {
    const extraOptions = [
        { val: 'dual-req', txt: 'Must be in Both' },
        { val: 'q-excl', txt: 'Exclusively Ques' },
        { val: 'a-excl', txt: 'Exclusively Answ' },
        { val: 'date-incl', txt: 'Include dates' }
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

async function triggerSearch() {
    const query = qInput.value.trim();
    if (!query) {
        statusMsg.innerText = "Please enter a search term.";
        return;
    }

    if (!SearchEngine.isLoaded) {
        if (isDownloading) return;
        isDownloading = true;
        
        // Initial message
        statusMsg.innerText = `Loading database...`;
        
        try {
            await SearchEngine.loadAllData(LOG_FILES, (current, total) => {
                const loadPercent = Math.round((current / total) * 100);
                statusMsg.innerText = `Loading database (${loadPercent}%)`;
            });
            
            const lastItem = SearchEngine.allData[SearchEngine.allData.length - 1];
            if (lastItem && lastItem.date) {
                const rawDate = lastItem.date.split(' ')[0]; 
                const parts = rawDate.split('.');
                if (parts.length === 3) {
                    const dateEl = document.getElementById('db-date');
                    if (dateEl) dateEl.innerText = `20${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
                }
            }
        } catch (e) {
            console.error(e);
            statusMsg.innerText = "Error loading database.";
            isDownloading = false;
            return;
        }
        isDownloading = false;
    }

    // Searching
    resultsArea.innerHTML = "";
    countDisplay.innerText = "";
    currentOffset = 0;
    currentResults = []; 

    statusMsg.innerText = "Searching...";
    
    const params = {
        query: query,
        sortBy: sortSelect.value,
        searchIn: filterSelect.value,
        regexEnabled: checkRegex.checked
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
        const dateHtml = `<a href="${item.link}" target="_blank">${item.dateHtml}</a>`;
        div.innerHTML = `
            <br><br>
            <h3> 
                <span class="dco">${dateHtml}</span> 
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