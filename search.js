// DB --
const StorageEngine = {
    CACHE_VERSION: 16,
    DB_NAME: "bwsearch-db",
    STORE_NAME: "logs",

    open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, this.CACHE_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.deleteObjectStore(this.STORE_NAME);
                }
                db.createObjectStore(this.STORE_NAME);
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = () => reject(req.error);
        });
    },

    get(db, key) {
        return new Promise((resolve) => {
            const tx = db.transaction([this.STORE_NAME], "readonly");
            const req = tx.objectStore(this.STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    },

    set(db, key, val) {
        return new Promise((resolve) => {
            const tx = db.transaction([this.STORE_NAME], "readwrite");
            const req = tx.objectStore(this.STORE_NAME).put(val, key);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
        });
    },

    deleteDatabase() {
        return new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(this.DB_NAME);

            req.onsuccess = () => { 
                console.log("Deleted the IndexedDB.");
                resolve();
            };
            req.onerror = () => {
                console.warn("Error deleting the IndexedDB:", req.error); 
                resolve(); 
            };
            req.onblocked = () => { 
                console.warn("Couldn't delete the IndexedDB."); 
                resolve(); 
            };
        });
    }
};

// Normalizer --
const TextNormalizer = {
    stripHtml(str) {
        return (str || "").replace(/<\/?a[^>]*>/gi, "");
    },

    clean(str) {
        if (!str) return "";
        return this.stripHtml(str)
            .toLowerCase()
            .replace(/['’]/g, "")           // remove apostrophes
            .replace(/(\d),(\d)/g, "$1$2")  // remove commas from numbers
            .replace(/[.,!?;:\-]/g, " ")    // remove punctuation
            .replace(/\s+/g, " ")           // remove whitespace
            .trim();
    },

    // formatting raw json into a runtime record
    createRecord(item) {
        const ts = item.info.ts || "";
        const ques = item.ques || "";
        const answ = item.answ || "";
        const hasLink = Boolean(item.info.hl);

        return {
            ts: ts,
            date: item.date || "",
            question: ques,
            answer: answ,
            hasLink: hasLink,
            qClean: this.clean(ques),
            aClean: this.clean(answ)
        };
    },

    // this is all we need, right?
    serializeForCache(record) {
        const payload = {
            ts: record.ts,
            date: record.date,
            ques: record.question,
            answ: record.answer,
            qClean: record.qClean,
            aClean: record.aClean
        };
        if (record.hasLink) {
            payload.hl = true;
        }
        return payload;
    },

    deserializeFromCache(entry) {
        return {
            ts: entry.ts,
            date: entry.date,
            question: entry.ques,
            answer: entry.answ,
            hasLink: Boolean(entry.hl),
            qClean: entry.qClean ?? this.clean(entry.ques),
            aClean: entry.aClean ?? this.clean(entry.answ)
        };
    }
};

// Compiler --
const QueryCompiler = {
    extractCommands(rawQuery) {
        let text = rawQuery.trim();
        const dateConditions = [];

        // regex mode
        const isRawRegex = text.startsWith("REGEX=") || text.toLowerCase().startsWith("regex:");
        if (isRawRegex) {
            return {
                isRawRegex: true,
                cleanQuery: text.substring(6),
                dateFilter: null
            };
        }

        // after:yyyy-mm-dd / before:yyyy-mm-dd
        const dateRegex = /\b(after|before):(\d{4}(?:-\d{2}(?:-\d{2})?)?)\b/gi;
        let match;
        while ((match = dateRegex.exec(text)) !== null) {
            const prefix = match[1].toLowerCase();
            const val = match[2];
            const limit = val.replace(/-/g, "").padEnd(12, prefix === "after" ? "9" : "0");
            if (prefix === "after") {
                dateConditions.push((ts) => ts > limit);
            } else {
                dateConditions.push((ts) => ts < limit);
            }
        }

        text = text.replace(dateRegex, "").trim();

        const dateFilter = dateConditions.length > 0
            ? (ts) => dateConditions.every((fn) => fn(ts))
            : null;

        return {
            isRawRegex: false,
            cleanQuery: text,
            dateFilter: dateFilter
        };
    },

    tokenize(queryString) {
        // matches quoted strings, parens, or words
        const tokenRegex = /"([^"]+)"|([()])|([^\s()]+)/g;
        const rawTokens = [];
        let match;

        while ((match = tokenRegex.exec(queryString)) !== null) {
            if (match[1] !== undefined) {
                rawTokens.push({ value: match[1], quoted: true });
            } else if (match[2] !== undefined) {
                rawTokens.push({ value: match[2], paren: true });
            } else if (match[3] !== undefined) {
                rawTokens.push({ value: match[3], word: true });
            }
        }
        return rawTokens;
    },

    compileBoolean(tokens, autoANDquery) {
        if (tokens.length === 0) return null;

        // Combine contiguous non-op words into phrases
        const grouped = [];
        for (const t of tokens) {
            const isOp = !t.quoted && ["AND", "OR", "XOR", "NOT"].includes(t.value);
            const isParen = t.paren;

            if (isOp || isParen) {
                grouped.push(t);
            } else {
                // AND if true
                if (!autoANDquery && grouped.length > 0 && grouped[grouped.length - 1].isTerm) {
                    grouped[grouped.length - 1].value += ` ${t.value}`;
                    if (t.quoted) grouped[grouped.length - 1].quoted = true;
                } else {
                    grouped.push({ value: t.value, isTerm: true, quoted: Boolean(t.quoted) });
                }
            }
        }

        // Implicit AND where needed
        const normalized = [];
        for (let i = 0; i < grouped.length; i++) {
            const current = grouped[i];
            if (i > 0) {
                const prev = grouped[i - 1];
                const prevEnds = prev.isTerm || prev.value === ")";
                const currStarts = (!current.quoted && current.value === "NOT") || current.value === "(" || current.isTerm;
                if (prevEnds && currStarts) {
                    normalized.push({ value: "AND", isOp: true });
                }
            }
            if (!current.quoted && ["AND", "OR", "XOR", "NOT"].includes(current.value)) {
                current.isOp = true;
            }
            normalized.push(current);
        }

        // Infix to Postfix (shunting yard)
        const postfix = [];
        const opStack = [];
        const precedence = { "OR": 1, "XOR": 1, "AND": 2, "NOT": 3 };
        const terms = [];

        for (const token of normalized) {
            if (token.isTerm) {
                const termObj = {
                    text: token.value,
                    exact: token.quoted,
                    clean: TextNormalizer.clean(token.value),
                    lower: token.value.toLowerCase().replace(/\s+/g, " ").trim(),
                    hasPunc: /[.,!?;:\-]/.test(token.value)
                };
                terms.push(termObj);
                postfix.push({ type: "TERM", termIndex: terms.length - 1 });
            } else if (token.value === "NOT") {
                opStack.push(token.value);
            } else if (["AND", "OR", "XOR"].includes(token.value)) {
                while (
                    opStack.length > 0 &&
                    opStack[opStack.length - 1] !== "(" &&
                    precedence[opStack[opStack.length - 1]] >= precedence[token.value]
                ) {
                    postfix.push({ type: "OP", op: opStack.pop() });
                }
                opStack.push(token.value);
            } else if (token.value === "(") {
                opStack.push("(");
            } else if (token.value === ")") {
                while (opStack.length > 0 && opStack[opStack.length - 1] !== "(") {
                    postfix.push({ type: "OP", op: opStack.pop() });
                }
                if (opStack.length === 0) return null; // unbalanced parentheses
                opStack.pop(); // discard "("
            }
        }

        while (opStack.length > 0) {
            const top = opStack.pop();
            if (top === "(" || top === ")") return null; // unbalanced
            postfix.push({ type: "OP", op: top });
        }

        return { postfix, terms };
    },

    evaluatePostfix(postfix, termEvaluator) {
        const stack = [];

        for (const node of postfix) {
            if (node.type === "TERM") {
                stack.push(termEvaluator(node.termIndex));
            } else if (node.type === "OP") {
                if (node.op === "NOT") {
                    if (stack.length < 1) return false;
                    const a = stack.pop();
                    stack.push(!a);
                } else if (node.op === "AND") {
                    if (stack.length < 2) return false;
                    const b = stack.pop();
                    const a = stack.pop();
                    stack.push(a && b);
                } else if (node.op === "OR") {
                    if (stack.length < 2) return false;
                    const b = stack.pop();
                    const a = stack.pop();
                    stack.push(a || b);
                } else if (node.op === "XOR") {
                    if (stack.length < 2) return false;
                    const b = stack.pop();
                    const a = stack.pop();
                    stack.push(Boolean(a) !== Boolean(b));
                }
            }
        }

        return stack.length === 1 ? stack[0] : false;
    }
};

// Highlighter --
const TextHighlighter = {
    buildTermRegexPart(term) {
        if (!term.text) return null;

        const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        // helper that expands characters to tolerate optional apostrophes and commas
        const expandCharacters = (str) => {
            const chars = [];
            for (let i = 0; i < str.length; i++) {
                chars.push(escapeRegex(str[i]));
                if (i < str.length - 1) {
                    const curr = str[i];
                    const next = str[i + 1];
                    if (/\d/.test(curr) && /\d/.test(next)) {
                        chars.push(",?");
                    } else if (/\S/.test(curr) && /\S/.test(next)) {
                        chars.push("['’]?");
                    }
                }
            }
            return chars.join("");
        };

        if (term.exact) {
            const boundaryStart = /^\w/.test(term.text) ? "\\b" : "";
            const boundaryEnd = /\w$/.test(term.text) ? "\\b" : "";
            const pattern = expandCharacters(term.text).replace(/\s+/g, "(?:\\s|<[^>]+>)+");
            return `${boundaryStart}${pattern}${boundaryEnd}`;
        }

        const cleanSource = term.hasPunc ? term.lower : (term.clean || term.lower);
        if (!cleanSource) return null;

        const words = cleanSource.split(/\s+/).filter((w) => w.length > 0);
        const wordPatterns = words.map((w) => expandCharacters(w));
        return wordPatterns.join("(?:[.,!?;:\\-\\s]|<[^>]+>)+");
    },

    highlight(text, terms, isRegexMode, rawRegexPattern) {
        if (!text) return "";
        if (isRegexMode && rawRegexPattern) {
            try {
                const combined = new RegExp(`(<[^>]+>)|(${rawRegexPattern.source})`, rawRegexPattern.flags);
                return text.replace(combined, (m, g1) => g1 ? g1 : `<span class="highlight">${m}</span>`);
            } catch (e) {
                return text;
            }
        }

        if (!terms || terms.length === 0) return text;

        const regexParts = terms
            .map((t) => this.buildTermRegexPart(t))
            .filter((p) => p !== null);

        if (regexParts.length === 0) return text;

        try {
            // /(<[^>]+>)/ captures html tags first so we can return them untouched
            const composite = new RegExp(`(<[^>]+>)|(${regexParts.join("|")})`, "gi");
            return text.replace(composite, (m, g1) => g1 ? g1 : `<span class="highlight">${m}</span>`);
        } catch (e) {
            return text;
        }
    }
};

// Search --
const SearchEngine = {
    allData: [],
    isLoaded: false,

    async deleteIndex() {
        await StorageEngine.deleteDatabase();
    },

    async loadAllData(fileList, onProgress, useCache) {
        let db = null;
        if (useCache) {
            try {
                db = await StorageEngine.open();
            } catch (e) {
                db = null;
            }
        }

        const totalFiles = fileList.length;
        let loadedCount = 0;

        const promises = fileList.map(async (fileUrl, index) => {
            const isLast = (index === fileList.length - 1);
            let items = null;

            // try to use the cache
            if (useCache && db && !isLast) {
                const cachedEntries = await StorageEngine.get(db, fileUrl);
                if (cachedEntries && Array.isArray(cachedEntries)) {
                    items = cachedEntries.map((e) => TextNormalizer.deserializeFromCache(e));
                }
            }

            // fetch if not
            if (!items) {
                try {
                    const fetchOptions = isLast ? { cache: "no-cache" } : {};
                    const response = await fetch(fileUrl, fetchOptions);
                    const rawJson = await response.json();

                    items = Object.values(rawJson).map((rawItem) => {
                        return TextNormalizer.createRecord(rawItem);
                    });

                    // 3. Cache the compact representations
                    if (useCache && db && !isLast) {
                        const serializable = items.map((rec) => TextNormalizer.serializeForCache(rec));
                        await StorageEngine.set(db, fileUrl, serializable);
                    }
                } catch (err) {
                    console.error(err);
                    items = [];
                }
            }

            loadedCount++;
            if (onProgress) onProgress(loadedCount, totalFiles);
            return items || [];
        });

        const nestedResults = await Promise.all(promises);

        const merged = [];
        for (const arr of nestedResults) {
            for (let i = 0; i < arr.length; i++) {
                merged.push(arr[i]);
            }
        }

        merged.sort((a, b) => (a.ts > b.ts ? 1 : a.ts < b.ts ? -1 : 0));

        this.allData = merged;
        this.isLoaded = true;
        return this.allData.length;
    },

    executeSearch(params) {
        const { query, sortBy, searchIn, autoAND } = params;
        const qTrim = (query || "").trim();

        if (!qTrim) {
            return { results: [], message: "" };
        }

        // Extract the commands
        const { isRawRegex, cleanQuery, dateFilter } = QueryCompiler.extractCommands(qTrim);

        let terms = [];
        let compiledQuery = null;
        let rawRegexObj = null;

        if (cleanQuery !== "") {
            if (isRawRegex) {
                try {
                    rawRegexObj = new RegExp(cleanQuery, "g");
                } catch (e) {
                    return { results: [], message: "Invalid regex." };
                }
                terms = [{ text: cleanQuery, exact: false, regex: rawRegexObj }];
            } else {
                const tokens = QueryCompiler.tokenize(cleanQuery);

                if (autoAND === true) {
                    compiledQuery = QueryCompiler.compileBoolean(tokens, true);
                } else {
                    compiledQuery = QueryCompiler.compileBoolean(tokens, false);
                }

                const invalidTerms = [
                    "AND",
                    "OR",
                    "NOT",
                    "XOR",
                    "()",
                    "( )"
                ];

                if (invalidTerms.includes(cleanQuery) || !compiledQuery) {
                    return { results: [], message: "Invalid query syntax." };
                }

                terms = compiledQuery.terms;

                // Prepare term regexes for exact word-boundary terms
                for (const t of terms) {
                    if (t.exact) {
                        const escaped = t.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                        const bS = /^\w/.test(t.text) ? "\\b" : "";
                        const bE = /\w$/.test(t.text) ? "\\b" : "";
                        try {
                            t.regex = new RegExp(`${bS}${escaped}${bE}`, "gi");
                        } catch (e) {
                            t.regex = null;
                        }
                    }
                }
            }
        }

        const includeDates = (searchIn === "date-incl" || searchIn === "date-excl");
        const showQ = ["both", "question", "dual-req", "q-excl", "date-incl"].includes(searchIn);
        const showA = ["both", "answer", "dual-req", "a-excl", "date-incl"].includes(searchIn);

        const countSubstrings = (str, sub) => {
            if (!str || !sub) return 0;
            let count = 0;
            let pos = str.indexOf(sub);
            while (pos !== -1) {
                count++;
                pos = str.indexOf(sub, pos + sub.length);
            }
            return count;
        };

        const countOccurrences = (targetText, cleanText, term) => {
            if (term.regex) {
                return ((targetText || "").match(term.regex) || []).length;
            }
            // if the query has punc, search the raw text just .lower()
            if (term.hasPunc) {
                const raw = TextNormalizer.stripHtml(targetText).toLowerCase();
                return countSubstrings(raw, term.lower);
            }
            // normal
            return countSubstrings(cleanText, term.clean);
        };

        const processedData = [];

        for (const item of this.allData) {
            if (sortBy === "links-only" && !item.hasLink) continue;
            if (dateFilter && !dateFilter(item.ts)) continue;

            // Pure date-range query without text
            if (cleanQuery === "") {
                processedData.push({
                    ...item,
                    matchCount: 0,
                    dateHtml: item.date,
                    questionHtml: item.question,
                    answerHtml: item.answer
                });
                continue;
            }

            const termMatches = [];
            let totalMatchCount = 0;

            for (let i = 0; i < terms.length; i++) {
                const term = terms[i];

                const qC = countOccurrences(item.question, item.qClean, term);
                const aC = countOccurrences(item.answer, item.aClean, term);
                const dC = includeDates ? countOccurrences(item.date, TextNormalizer.clean(item.date), term) : 0;

                let hasM = false;
                if (searchIn === "both") hasM = (qC > 0 || aC > 0);
                else if (searchIn === "question") hasM = (qC > 0);
                else if (searchIn === "answer") hasM = (aC > 0);
                else if (searchIn === "dual-req") hasM = (qC > 0 && aC > 0);
                else if (searchIn === "q-excl") hasM = (qC > 0 && aC === 0);
                else if (searchIn === "a-excl") hasM = (aC > 0 && qC === 0);
                else if (searchIn === "date-incl") hasM = (dC > 0 || qC > 0 || aC > 0);
                else if (searchIn === "date-excl") hasM = (dC > 0);

                termMatches.push(hasM);

                if (searchIn === "question" || searchIn === "q-excl") totalMatchCount += qC;
                else if (searchIn === "answer" || searchIn === "a-excl") totalMatchCount += aC;
                else if (searchIn === "date-excl") totalMatchCount += dC;
                else totalMatchCount += (dC + qC + aC);
            }

            let isMatch = false;
            if (isRawRegex) {
                isMatch = termMatches[0];
            } else {
                isMatch = QueryCompiler.evaluatePostfix(compiledQuery.postfix, (idx) => termMatches[idx]);
            }

            if (isMatch) {
                processedData.push({
                    ...item,
                    matchCount: totalMatchCount,
                    dateHtml: includeDates ? TextHighlighter.highlight(item.date, terms, isRawRegex, rawRegexObj) : item.date,
                    questionHtml: showQ ? TextHighlighter.highlight(item.question, terms, isRawRegex, rawRegexObj) : item.question,
                    answerHtml: showA ? TextHighlighter.highlight(item.answer, terms, isRawRegex, rawRegexObj) : item.answer
                });
            }
        }

        // sorting using TS now
        if (sortBy === "oldest") {
            processedData.sort((a, b) => (a.ts > b.ts ? 1 : a.ts < b.ts ? -1 : 0));
        } else if (sortBy === "frequency") {
            processedData.sort((a, b) => (b.matchCount - a.matchCount) || (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));
        } else if (sortBy === "randy") {
            // deterministic shuffle
            let srch = 0;
            for (let i = 0; i < query.length; i++) {
                srch = (srch << 5) - srch + query.charCodeAt(i);
            }
            for (let i = processedData.length - 1; i > 0; i--) {
                srch = Math.imul(srch, 1234567891) + 0xABCDEF1 | 0;
                const j = Math.abs(srch) % (i + 1);
                const temp = processedData[i];
                processedData[i] = processedData[j];
                processedData[j] = temp;
            }
        } else {
            // newest
            processedData.sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));
        }

        return { results: processedData, message: "" };
    }
};
