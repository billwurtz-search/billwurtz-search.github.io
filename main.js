// -- Load files --
const LOG_FILES = [];
for (let i = 1; i <= 14; i++) {
  const num = i.toString().padStart(2, '0');
  LOG_FILES.push(`logs/log_${num}.json`);
}

const logs = [];

for (const file of LOG_FILES) {
  fetch(file)
    .then(r => r.json())
    .then(data => logs.push(data))
    .catch(err => console.error(file, err));
}

// -- State --
let currentResults = [];
let currentOffset = 0;
let currentLimit = 100;

// -- DOM Elements --
const form = document.getElementById('search-form');
const qInput = document.getElementById('q');
const sortSelect = document.getElementById('sort');
const filterSelect = document.getElementById('filter');
const resultsArea = document.getElementById('results-area');
const countDisplay = document.getElementById('count-display');
const statusMsg = document.getElementById('status-msg');
const sentinel = document.getElementById('sentinel');

// Config Modal Elements
const modal = document.getElementById('config-modal');
const configBtn = document.getElementById('config-btn');
const closeModal = document.getElementById('close-modal');
const limitSlider = document.getElementById('limit-slider');
const limitLabel = document.getElementById('limit-label');
const checkLinks = document.getElementById('check-links');
const checkHighlight = document.getElementById('check-highlight');
const checkRegex = document.getElementById('check-regex');

// -- INITIALIZATION --
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const count = await SearchEngine.loadAllData(LOG_FILES);
        countDisplay.innerText = "";
        statusMsg.innerText = "Search stuff to search.";
    } catch (e) {
        statusMsg.innerText = "Error loading database :(";
    }
    
    qInput.value = '';
});

// -- UI listeners --

form.addEventListener('submit', (e) => {
    e.preventDefault();
    triggerSearch();
});

configBtn.onclick = () => modal.style.display = "block";
closeModal.onclick = () => modal.style.display = "none";
window.onclick = (e) => {
    if (e.target == modal) modal.style.display = "none";
};

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

checkRegex.onchange = function() {
    if (qInput.value.trim()) triggerSearch();
};

// -- L o g i c --

function triggerSearch() {
    if (!SearchEngine.isLoaded) return;

    const query = qInput.value.trim();
    
    resultsArea.innerHTML = "";
    countDisplay.innerText = "";
    currentOffset = 0;
    currentResults = []; 

    if (!query) {
        statusMsg.innerText = "Please enter a search term.";
        return;
    }

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
        
        if (currentResults.length === 0) {
            countDisplay.innerText = "Found 0 results.";
            statusMsg.innerText = "No results found.";
        } else {
            countDisplay.innerText = `Found ${currentResults.length} results.`;
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
        const dateHtml = `<a href="${item.link}" target="_blank">${item.date}</a>`;

        // Updated to use standard classes instead of custom tags
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

    if (currentOffset >= currentResults.length) {
        statusMsg.innerText = "End of results.";
    } else {
        statusMsg.innerText = "";
    }
}

// -- Infinite Scroll --
const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
        if (currentResults.length > 0 && currentOffset < currentResults.length) {
            renderBatch();
        }
    }
}, { threshold: 0.1 });


observer.observe(sentinel);
