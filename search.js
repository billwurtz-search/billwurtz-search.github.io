const cacheVersion = 10;

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

    // delete
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
            if (useCache && db && !isLast) { content = await this._getFromDB(db, f); }

            // fetch
            if (!content) {
                try {
                    const fetchOptions = isLast ? { cache: 'no-cache' } : {}; // realize the file is different
                    
                    const response = await fetch(f, fetchOptions);
                    const rawJson = await response.json();

                    // it becomes a raw array
                    content = Object.keys(rawJson).map(key => {
                        const item = rawJson[key];
                        
                        const tsStr = item.info ? item.info.ts : "";
                        const hasLink = item.info ? !!item.info.hl : false;
                        
                        const stripA = (s) => (s || "").replace(/<\/?a[^>]*>/gi, '');
                        
                        const q_low = stripA(item.ques).toLowerCase();
                        const a_low = stripA(item.answ).toLowerCase();
                        const d_low = (item.date || "").toLowerCase();
                        const punc = /[.,!?;:\-]/g;
                        const apos = /['’]/g;

                        return {
                            id: key,
                            link: tsStr ? `https://billwurtz.com/questions/q.php?date=${tsStr}` : "",
                            date: item.date, 
                            question: item.ques || "",
                            answer: item.answ || "",
                            hasLink: hasLink,
                            q_lower: q_low.replace(apos, ''),
                            a_lower: a_low.replace(apos, ''),
                            q_clean: q_low.replace(apos, '').replace(punc, ' ').replace(/\s+/g, ' ').trim(),
                            a_clean: a_low.replace(apos, '').replace(punc, ' ').replace(/\s+/g, ' ').trim(),
                            d_clean: d_low.replace(apos, '').replace(punc, ' ').replace(/\s+/g, ' ').trim(),
                            ts: tsStr
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

        // close it so we can delete it
        if (db) { db.close(); }
        
        // merge safely
        results.forEach(arr => { if (arr) tempArray.push(...arr); });

        tempArray.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
        this.allData = tempArray;
        this.isLoaded = true;
        return this.allData.length;
    },

parseBooleanQuery(query) {
        const regex = /"([^"]+)"|(\S+)/g;
        let match, tokens = [];
        while ((match = regex.exec(query)) !== null) {
            let val = match[1] || match[2];
            let quoted = match[1] !== undefined;
            
            if (!quoted && !['AND', 'OR', 'XOR', 'NOT', '(', ')'].includes(val)) {
                const cleaned = val.replace(/^[.,!?;:\-]+|[.,!?;:\-]+$/g, '');
                val = cleaned === "" ? val : cleaned;
            }
            if (val) tokens.push({ val: val, quoted: quoted });
        }
        if (tokens.length === 0) return null;

        let expressionParts = [], terms = [];
        tokens.forEach(tokenObj => {
            const rawVal = tokenObj.val;
            
            if (!tokenObj.quoted && ['AND', 'OR', 'XOR', 'NOT'].includes(rawVal)) {
                if (rawVal === 'NOT') {
                    if (expressionParts.length > 0 && !['&&', '||', '!='].includes(expressionParts[expressionParts.length - 1])) {
                        expressionParts.push('&&');
                    } expressionParts.push('!');
                } else {
                    expressionParts.push(rawVal === 'AND' ? '&&' : (rawVal === 'OR' ? '||' : '!='));
                }
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
            t.exact = (t.explicitQuote || query.includes(`"${t.text}"`));
            t.lower = t.text.toLowerCase().replace(/['’]/g, '');
            t.clean = t.lower.replace(/[.,!?;:\-]/g, ' ').replace(/\s+/g, ' ').trim();
            if (t.clean === "") t.clean = t.lower;
        });

        const codeStr = `return ${expressionParts.join(' ')};`;
        try {
            new Function('vals', codeStr);
            return { codeStr, terms };
        } catch (e) { return null; }
    },

    highlightText(text, patterns, isRegexMode) {
        if (!text || !patterns) return text || "";

        if (isRegexMode) {
            try { return text.replace(patterns, (m) => `<span class="highlight">${m}</span>`); } catch (e) { return text; }
        }
        
        // build regex strings list
        const regexParts = patterns.map(term => {
            if (!term.text) return null;
            if (term.exact) {
                const baseText = term.text.replace(/['’]/g, '');
                const withApos = baseText.replace(/(\S)(?=\S)/g, '$1\x01'); // placeholder injection
                const escaped = withApos.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\x01/g, '[\'’]?');
                const htmlAware = escaped.replace(/\s+/g, '(?:\\s|<[^>]+>)+');
                const bS = /^\w/.test(baseText) ? '\\b' : '';
                const bE = /\w$/.test(baseText) ? '\\b' : '';
                return `${bS}${htmlAware}${bE}`;
            } else {
                const source = term.clean || term.lower;
                if (!source || source.trim() === "") return null;
                const parts = source.split(/\s+/).filter(p => p.length > 0);
                const escapedParts = parts.map(p => {
                    const withApos = p.replace(/(\S)(?=\S)/g, '$1\x01');
                    return withApos.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\x01/g, '[\'’]?');
                });
                return escapedParts.join('(?:[.,!?;:\\-\\s]|<[^>]+>)+');
            }
        }).filter(p => p !== null);

        if (regexParts.length === 0) return text;

        // 'dont match if followed by a closing > without an opening < first'
        const compositePattern = `(${regexParts.join('|')})(?![^<]*>)`;
        
        try {
            const compositeRegex = new RegExp(compositePattern, isRegexMode ? 'g' : 'gi');
            return text.replace(compositeRegex, (m) => `<span class="highlight">${m}</span>`);
        } catch (e) { return text; }
    },

    executeSearch(params) {
        let { query, sortBy, searchIn } = params;
        const includeDates = (searchIn === 'date-incl' || searchIn === 'date-excl');

        let qTrim = query.trim();
        if (!qTrim) return { results: [], message: "" };

        const isRawRegex = (qTrim.startsWith("REGEX="));

        let dateFilter = null;
        if (!isRawRegex) {
            const dtMatches = qTrim.match(/\b(after|before):(\d{4}(?:-\d{2})?)\b/g);
            if (dtMatches) {
                const conditions = dtMatches.map(m => {
                    const [prefix, val] = m.split(':');
                    const limit = val.replace('-', '').padEnd(12, '0');
                    return prefix === 'after' ? (ts) => ts >= limit : (ts) => ts < limit;
                });
                dateFilter = (ts) => conditions.every(cond => cond(ts));
                qTrim = qTrim.replace(/\b(after|before):(\d{4}(?:-\d{2})?)\b/g, '').trim();
            }
        }

        let processedData = [];
        let terms = [], evalFunc = null, isComplex = false;

        if (qTrim !== "" || dateFilter) {
            if (qTrim !== "") {
                if (!isRawRegex) {
                    const parsed = this.parseBooleanQuery(qTrim);
                    if (!parsed) return { results: [], message: "Invalid query syntax." };
                    terms = parsed.terms;
                    evalFunc = new Function('vals', parsed.codeStr);
                    isComplex = qTrim.includes(' OR ') || qTrim.includes(' XOR ') || qTrim.includes(' NOT ') || qTrim.startsWith('NOT ');
                } else {
                    const clean = isRawRegex ? qTrim.substring(6) : qTrim.replace(/^[.,!?;:]+|[.,!?;:]+$/g, '');
                    const finalText = clean === "" ? qTrim : clean;
                    const lit = { text: finalText, exact: false, lower: finalText.toLowerCase().replace(/['’]/g, '') };
                    lit.clean = lit.lower.replace(/[.,!?;:\-]/g, ' ').replace(/\s+/g, ' ').trim();
                    if (lit.clean === "") lit.clean = lit.lower; // ensure we have a search term
                    terms = [lit];
                }
                
                terms.forEach(t => {
                    try {
                        if (t.exact || isRawRegex) {
                            const baseText = isRawRegex ? t.text : t.text.replace(/['’]/g, '');
                            const escaped = baseText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const bS = (!isRawRegex && /^\w/.test(baseText)) ? '\\b' : '';
                            const bE = (!isRawRegex && /\w$/.test(baseText)) ? '\\b' : '';
                            const flags = isRawRegex ? 'g' : 'gi';
                            t.regexGlobal = new RegExp(isRawRegex ? t.text : `${bS}${escaped}${bE}`, flags);
                        }
                    } catch (e) { t.regexGlobal = null; }
                });
            }

            for (const item of this.allData) {
                if (sortBy === 'links-only' && !item.hasLink) continue;
                if (dateFilter && !dateFilter(item.ts)) continue;
                if (qTrim === "") {
                    processedData.push({ ...item, matchCount: 0, dateHtml: item.date, questionHtml: item.question, answerHtml: item.answer });
                    continue;
                }

                let totalCounts = 0, vals = [], skipItem = false;
                for (const term of terms) {
                    const check = (txt, low, clean) => {
                        if (term.regexGlobal) {
                            const target = isRawRegex ? txt : low;
                            return ((target || "").match(term.regexGlobal) || []).length;
                        }
                        
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
                    else if (searchIn === 'date-excl') hasM = (dC > 0 && qC === 0 && aC === 0);
                    else if (searchIn === 'xor-res') hasM = (qC > 0) !== (aC > 0);

                    if (!isComplex && !hasM) { skipItem = true; break; }
                    vals.push(hasM); 
                    if (searchIn === 'question' || searchIn === 'q-excl') totalCounts += qC;
                    else if (searchIn === 'answer' || searchIn === 'a-excl') totalCounts += aC;
                    else if (searchIn === 'date-excl') totalCounts += dC;
                    else totalCounts += (dC + qC + aC);
                }

                if (!skipItem) {
                    let isMatch = false;
                    if (isComplex) { try { isMatch = evalFunc(vals); } catch(e) { isMatch = false; } }
                    else { isMatch = true; }

                    if (isMatch) {
                        const hPats = isRawRegex ? (terms[0] ? terms[0].regexGlobal : null) : terms;
                        const showA = ['both', 'answer', 'dual-req', 'a-excl', 'date-incl', 'xor-res'].includes(searchIn);
                        const showQ = ['both', 'question', 'dual-req', 'q-excl', 'date-incl', 'xor-res'].includes(searchIn);
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
            let srch = 0;
            for (let i = 0; i < query.length; i++) srch = (srch << 5) - srch + query.charCodeAt(i);
            for (let i = processedData.length - 1; i > 0; i--) {
                srch = Math.imul(srch, 1234567891) + 0xABCDEF1 | 0;
                const j = Math.abs(srch) % (i + 1);
                [processedData[i], processedData[j]] = [processedData[j], processedData[i]];
            }
        } // newest
        else processedData.sort((a, b) => (parseInt(b.id)||0) - (parseInt(a.id)||0));
        return { results: processedData, message: "" };
    }
};
