const cacheVersion = 4; 

const SearchEngine = {
    allData: [],
    isLoaded: false,

    // open or create the database
    _openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open("bwsearch-db", cacheVersion);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (db.objectStoreNames.contains("logs")) db.deleteObjectStore("logs");
                db.createObjectStore("logs");
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = () => reject();
        });
    },

    // read
    _getFromDB(db, key) {
        return new Promise((resolve) => {
            const tx = db.transaction(["logs"], "readonly");
            const req = tx.objectStore("logs").get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    },

    // write
    _putToDB(db, key, val) {
        return new Promise((resolve) => {
            const tx = db.transaction(["logs"], "readwrite");
            const req = tx.objectStore("logs").put(val, key);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
        });
    },


    deleteIndex() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase("bwsearch-db");

        req.onsuccess = () => {
            console.log("database deleted");
            resolve();
        };

        req.onerror = () => reject();

        req.onblocked = () => {
            console.log("couldn't delete the database");
            reject();
        };
    });
},

async loadAllData(fileList, onProgress, useCache) {
        let tempArray = [];
        let loadedCount = 0;
        const totalFiles = fileList.length;
        let db = null;

        // fail silently
        try { if (useCache) db = await this._openDB(); } catch (e) {}

        const promises = fileList.map(async (f, index) => {
            let content = null;
            const isLast = (index === fileList.length - 1);

            // try database
            if (useCache && db && !isLast) {
                content = await this._getFromDB(db, f);
            }

            // fetch
            if (!content) {
                try {
                    const response = await fetch(f);
                    const raw = await response.json();

                    // it becomes a raw array
                    content = Object.keys(raw).map(key => {
                        const item = raw[key];
                        const q_low = (item.question || "").toLowerCase();
                        const a_low = (item.answer || "").toLowerCase();
                        const d_low = (item.date || "").toLowerCase();
                        const punc = /[.,!?;:\-]/g;

                        return {
                            id: key,
                            link: item.link,
                            date: item.date,
                            question: item.question,
                            answer: item.answer,
                            q_lower: q_low,
                            a_lower: a_low,
                            q_clean: q_low.replace(punc, ' ').replace(/\s+/g, ' ').trim(),
                            a_clean: a_low.replace(punc, ' ').replace(/\s+/g, ' ').trim(),
                            d_clean: d_low.replace(punc, ' ').replace(/\s+/g, ' ').trim(),
                            ts: (item.link && item.link.split('date=')[1] || "").replace(/[-:\.]/g, '')
                        };
                    });

                    // save the array
                    if (useCache && db && !isLast) this._putToDB(db, f, content);
                } catch (err) { console.error(err); }
            }

            loadedCount++;
            if (onProgress) onProgress(loadedCount, totalFiles);
            return content || [];
        });

        const results = await Promise.all(promises);

        // make it so that we can actually delete the database 
        if (db) {
            db.close();
        }
        
        // merge safely
        results.forEach(arr => {
            if (arr) tempArray.push(...arr);
        });

        tempArray.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
        this.allData = tempArray;
        this.isLoaded = true;
        return this.allData.length;
    },

parseBooleanQuery(query) {
        const regex = /"([^"]+)"|'([^']+)'|(\S+)/g;
        let match, tokens = [];
        while ((match = regex.exec(query)) !== null) {
            let val = match[1] || match[2] || match[3];
            let quoted = match[1] !== undefined || match[2] !== undefined;
            
            if (!quoted && !['AND', 'OR', 'XOR', '(', ')'].includes(val)) {
                const cleaned = val.replace(/^[.,!?;:\-]+|[.,!?;:\-]+$/g, '');
                val = cleaned === "" ? val : cleaned;
            }
            if (val) tokens.push({ val: val, quoted: quoted });
        }
        if (tokens.length === 0) return null;

        let expressionParts = [], terms = [];
        tokens.forEach(tokenObj => {
            const rawVal = tokenObj.val;
            
            if (!tokenObj.quoted && ['AND', 'OR', 'XOR'].includes(rawVal)) {
                expressionParts.push(rawVal === 'AND' ? '&&' : (rawVal === 'OR' ? '||' : '!='));
            } else if (!tokenObj.quoted && rawVal === '(') {
                expressionParts.push('(');
            } else if (!tokenObj.quoted && rawVal === ')') {
                expressionParts.push(')');
            } else {
                if (expressionParts.length > 0 && expressionParts[expressionParts.length - 1].startsWith("vals[")) {
                    terms[terms.length - 1].text += " " + rawVal;
                    if (tokenObj.quoted) terms[terms.length - 1].explicitQuote = true;
                } else {
                    terms.push({ text: rawVal, explicitQuote: tokenObj.quoted });
                    expressionParts.push(`vals[${terms.length - 1}]`);
                }
            }
        });

        if (terms.length === 0) return null;

        terms.forEach(t => {
            t.exact = (t.explicitQuote || query.includes(`"${t.text}"`) || query.includes(`'${t.text}'`));
            t.lower = t.text.toLowerCase();
            t.clean = t.lower.replace(/[.,!?;:\-]/g, ' ').replace(/\s+/g, ' ').trim();
            if (t.clean === "") t.clean = t.lower;
        });

        const codeStr = `return ${expressionParts.join(' ')};`;
        try {
            new Function('vals', codeStr);
            return { codeStr, terms };
        } catch (e) { 
            return null; 
        }
    },

    highlightText(text, patterns, isRegexMode) {
        if (!text || !patterns) return text || "";

        if (isRegexMode) {
            try { return text.replace(patterns, (m) => `<span class="highlight">${m}</span>`); } catch (e) { return text; }
        }
        
        // build a list of valid regex strings for each term
        const regexParts = patterns.map(term => {
            if (!term.text) return null;
            if (term.exact) {
                const escaped = term.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const bS = /^\w/.test(term.text) ? '\\b' : '';
                const bE = /\w$/.test(term.text) ? '\\b' : '';
                return `${bS}${escaped}${bE}`;
            } else {
                const source = term.clean || term.lower;
                if (!source || source.trim() === "") return null;
                const parts = source.split(/\s+/).filter(p => p.length > 0);
                const escapedParts = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                return escapedParts.join('[.,!?;:\\-\\s]+');
            }
        }).filter(p => p !== null);

        if (regexParts.length === 0) return text;

        // 'dont match if followed by a closing > without an opening < first'
        const compositePattern = `(${regexParts.join('|')})(?![^<]*>)`;
        
        try {
            const compositeRegex = new RegExp(compositePattern, 'gi');
            return text.replace(compositeRegex, (m) => `<span class="highlight">${m}</span>`);
        } catch (e) {
            return text;
        }
    },

    executeSearch(params) {
        let { query, sortBy, searchIn } = params;
        const regexEnabled = true;
        const includeDates = (searchIn === 'date-incl');

        let qTrim = query.trim();
        if (!qTrim) return { results: [], message: "" };

        const isRawRegex = (regexEnabled && qTrim.startsWith("REGEX="));

    let dateFilter = null;
        if (!isRawRegex) {
            const dMatch = qTrim.match(/\b(before:|bfr:|after:|aft:|range:|rng:)([0-9\-\.:]+?)(?:\.\.([0-9\-\.:]+))?(?=\s|$)/);
            if (dMatch) {
                const fullTag = dMatch[0], op = dMatch[1], d1 = dMatch[2], d2 = dMatch[3];

                // make sure we have the year at least
                const d1Clean = d1.replace(/[-:\.]/g, '');
                if (d1Clean.length < 4) return { results: [], message: "Invalid date range." };

                if (op.startsWith('r')) {
                    if (!d2) return { results: [], message: "Invalid date range." };
                    const d2Clean = d2.replace(/[-:\.]/g, '');
                    if (d2Clean.length < 4) return { results: [], message: "Invalid date range." };
                }

                qTrim = qTrim.replace(fullTag, '').trim();
                const pad = (s, char) => (s || "").replace(/[-:\.]/g, '').padEnd(12, char);

                if (op.startsWith('b')) dateFilter = (ts) => ts < pad(d1, '0');
                else if (op.startsWith('a')) dateFilter = (ts) => ts >= pad(d1, '0');
                else if (op.startsWith('r')) {
                    dateFilter = (ts) => ts >= pad(d1, '0') && ts <= pad(d2, '9');
                }
            }
        }

        let processedData = [];
        let terms = [], evalFunc = null, isComplex = false;

        if (qTrim !== "" || dateFilter) {
            if (qTrim !== "") {
                if (regexEnabled && !isRawRegex) {
                    const parsed = this.parseBooleanQuery(qTrim);
                    if (!parsed) return { results: [], message: "Invalid query syntax." };
                    terms = parsed.terms;
                    evalFunc = new Function('vals', parsed.codeStr);
                    isComplex = qTrim.includes(' OR ') || qTrim.includes(' XOR ');
                } else {
                    const clean = isRawRegex ? qTrim.substring(6) : qTrim.replace(/^[.,!?;:]+|[.,!?;:]+$/g, '');
                    const finalText = clean === "" ? qTrim : clean;
                    const lit = { text: finalText, exact: false, lower: finalText.toLowerCase() };
                    lit.clean = lit.lower.replace(/[.,!?;:\-]/g, ' ').replace(/\s+/g, ' ').trim();
                    if (lit.clean === "") lit.clean = lit.lower; // ensure we have a search term
                    terms = [lit];
                }
                
                terms.forEach(t => {
                    try {
                        if (t.exact || isRawRegex) {
                            const escaped = t.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const bS = (!isRawRegex && /^\w/.test(t.text)) ? '\\b' : '';
                            const bE = (!isRawRegex && /\w$/.test(t.text)) ? '\\b' : '';
                            t.regexGlobal = new RegExp(isRawRegex ? t.text : `${bS}${escaped}${bE}`, 'gi');
                        }
                    } catch (e) { t.regexGlobal = null; }
                });
            }

            for (const item of this.allData) {
                if (dateFilter && !dateFilter(item.ts)) continue;
                if (qTrim === "") {
                    processedData.push({ ...item, matchCount: 0, dateHtml: item.date, questionHtml: item.question, answerHtml: item.answer });
                    continue;
                }

                let totalCounts = 0, vals = [], skipItem = false;
                for (const term of terms) {
                    const check = (txt, low, clean) => {
                        if (term.regexGlobal) return ((txt || "").match(term.regexGlobal) || []).length;
                        
                        const useRaw = (!term.clean || term.clean.length === 0 || /[^\w\s]/.test(term.lower));
                        const target = useRaw ? low : clean;
                        const find = useRaw ? term.lower : term.clean;
                        
                        if (!find || !target || find.length === 0) return 0;
                        
                        let c = 0, pos = target.indexOf(find);
                        while (pos !== -1) { c++; pos = target.indexOf(find, pos + 1); }
                        return c;
                    };

                    const dC = includeDates ? check(item.date, item.date, item.d_clean) : 0;
                    const qC = check(item.question, item.q_lower, item.q_clean);
                    const aC = check(item.answer, item.a_lower, item.a_clean);
                    
                    let hasM = false;
                    if (searchIn === 'both') hasM = (qC > 0 || aC > 0);
                    else if (searchIn === 'question') hasM = (qC > 0);
                    else if (searchIn === 'answer') hasM = (aC > 0);
                    else if (searchIn === 'dual-req') hasM = (qC > 0 && aC > 0);
                    else if (searchIn === 'q-excl') hasM = (qC > 0 && aC === 0);
                    else if (searchIn === 'a-excl') hasM = (aC > 0 && qC === 0);
                    else if (searchIn === 'date-incl') hasM = (dC > 0 || qC > 0 || aC > 0);

                    if (!isComplex && !hasM) { skipItem = true; break; }
                    vals.push(hasM); 
                    if (searchIn === 'question' || searchIn === 'q-excl') totalCounts += qC;
                    else if (searchIn === 'answer' || searchIn === 'a-excl') totalCounts += aC;
                    else totalCounts += (dC + qC + aC);
                }

                if (!skipItem) {
                    let isMatch = false;
                    if (isComplex) { try { isMatch = evalFunc(vals); } catch(e) { isMatch = false; } }
                    else { isMatch = true; }

                    if (isMatch) {
                        const hPats = isRawRegex ? (terms[0] ? terms[0].regexGlobal : null) : terms;
                        const showA = ['both','answer','dual-req','a-excl','date-incl'].includes(searchIn);
                        const showQ = ['both','question','dual-req','q-excl','date-incl'].includes(searchIn);
                        processedData.push({
                            ...item, matchCount: totalCounts,
                            dateHtml: includeDates ? this.highlightText(item.date, hPats, isRawRegex) : item.date,
                            questionHtml: showQ ? this.highlightText(item.question, hPats, isRawRegex) : item.question,
                            answerHtml: showA ? this.highlightText(item.answer, hPats, isRawRegex) : item.answer
                        });
                    }
                }
            }
        }

        if (sortBy === 'oldest') processedData.sort((a, b) => (parseInt(a.id)||0) - (parseInt(b.id)||0));
        else if (sortBy === 'frequency') processedData.sort((a, b) => (b.matchCount - a.matchCount) || ((parseInt(b.id)||0) - (parseInt(a.id)||0)));
        else if (sortBy === 'randy') {
            for (let i = processedData.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [processedData[i], processedData[j]] = [processedData[j], processedData[i]];
            }
        } else processedData.sort((a, b) => (parseInt(b.id)||0) - (parseInt(a.id)||0));

        return { results: processedData, message: "" };
    }
};
