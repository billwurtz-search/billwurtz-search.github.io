const SearchEngine = {
    allData: [],
    isLoaded: false,

    // -- Data Loading --
    async loadAllData(fileList) {
        let tempArray = [];
        try {
            const promises = fileList.map(fileName => 
                fetch(fileName)
                    .then(res => {
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        return res.json();
                    })
                    .catch(err => {
                        console.warn(`Failed to load ${fileName}:`, err);
                        return null;
                    })
            );

            const results = await Promise.all(promises);

            results.forEach(jsonContent => {
                if (!jsonContent) return;
                Object.keys(jsonContent).forEach(key => {
                    const item = jsonContent[key];
                    item.id = key; 
                    item.q_lower = (item.question || "").toLowerCase();
                    item.a_lower = (item.answer || "").toLowerCase();
                    tempArray.push(item);
                });
            });

            tempArray.sort((a, b) => parseInt(a.id) - parseInt(b.id));
            this.allData = tempArray;
            this.isLoaded = true;
            return this.allData.length;
        } catch (err) {
            console.error("Critical error loading data:", err);
            throw err;
        }
    },

    // -- Query Parsing --
    parseBooleanQuery(query) {
        // tokenizer handles quotes or non-space words
        const regex = /"([^"]+)"|'([^']+)'|(\S+)/g;
        let match;
        const tokens = [];
        
        while ((match = regex.exec(query)) !== null) {
            let val = match[1] || match[2] || match[3];
            let quoted = match[1] !== undefined || match[2] !== undefined;

            if (!quoted && !['AND', 'OR', 'XOR', '(', ')'].includes(val.toUpperCase())) {
                val = val.replace(/^[.,!?;:]+|[.,!?;:]+$/g, '');
            }

            if (val) tokens.push({ val: val, quoted: quoted });
        }

        if (tokens.length === 0) return null;

        let expressionParts = [];
        let terms = [];
        
        tokens.forEach(tokenObj => {
            const rawVal = tokenObj.val;
            
            if (!tokenObj.quoted && ['AND', 'OR', 'XOR'].includes(rawVal.toUpperCase())) {
                const op = rawVal.toUpperCase();
                if (op === 'AND') expressionParts.push('&&');
                if (op === 'OR') expressionParts.push('||');
                if (op === 'XOR') expressionParts.push('!='); 
            } else if (!tokenObj.quoted && rawVal === '(') {
                expressionParts.push('(');
            } else if (!tokenObj.quoted && rawVal === ')') {
                expressionParts.push(')');
            } else {
                // Merge adjacent terms (Implicit Phrase)
                if (expressionParts.length > 0 && expressionParts[expressionParts.length - 1].startsWith("vals[")) {
                    const lastIdx = terms.length - 1;
                    terms[lastIdx].text += " " + rawVal;
                    if (tokenObj.quoted) terms[lastIdx].explicitQuote = true;
                } else {
                    const index = terms.length;
                    terms.push({ text: rawVal, explicitQuote: tokenObj.quoted });
                    expressionParts.push(`vals[${index}]`);
                }
            }
        });

        if (terms.length === 0) return null;

        terms.forEach(t => {
            // was the original term wrapped in quotes?
            if (t.explicitQuote || query.includes(`"${t.text}"`) || query.includes(`'${t.text}'`)) {
                t.exact = true;
            } else {
                t.exact = false;
            }
        });

        const codeStr = `return ${expressionParts.join(' ')};`;
        try {
            new Function('vals', codeStr);
            return { codeStr, terms };
        } catch (e) { return null; }
    },

    // -- Highlighting --
    highlightText(text, patterns, isRegexMode) {
        if (!text) return "";
        if (!patterns) return text;
        let result = text;

        if (isRegexMode) {
            try {
                result = text.replace(patterns, (match) => `<span class="highlight">${match}</span>`);
            } catch (e) { return text; }
        } else {
            patterns.forEach(term => {
                const queryStr = term.text;
                const escaped = queryStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                
                let regex;
                if (term.exact) {
                    // match word boundaries only if the term starts/ends with a word character
                    const startBoundary = /^\w/.test(queryStr) ? '\\b' : '';
                    const endBoundary = /\w$/.test(queryStr) ? '\\b' : '';
                    regex = new RegExp(`${startBoundary}${escaped}${endBoundary}`, 'gi');
                } else {
                    regex = new RegExp(escaped, 'gi');
                }
                result = result.replace(regex, (match) => `<span class="highlight">${match}</span>`);
            });
        }
        return result;
    },

    // -- Main Search --
    executeSearch(params) {
        const { query, sortBy, searchIn, regexEnabled } = params;
        if (!query.trim()) return { results: [], message: "" };
        let processedData = [];

        // 1. REGEX MODE
        if (regexEnabled && query.startsWith("REGEX=")) {
            const regexStr = query.substring(6);
            let regexPattern;
            try {
                regexPattern = new RegExp(regexStr, 'g'); 
            } catch (e) { return { results: [], message: "Invalid regex." }; }

            for (const item of this.allData) {
                let count = 0;
                const countMatches = (str) => {
                    if (!str) return 0;
                    regexPattern.lastIndex = 0; 
                    const matches = str.match(regexPattern);
                    return matches ? matches.length : 0;
                };

                if (searchIn === 'question' || searchIn === 'both') count += countMatches(item.question);
                if (searchIn === 'answer' || searchIn === 'both') count += countMatches(item.answer);

                if (count > 0) {
                    const resItem = { ...item };
                    resItem.matchCount = count;
                    resItem.questionHtml = (searchIn === 'question' || searchIn === 'both') ? this.highlightText(item.question, regexPattern, true) : item.question;
                    resItem.answerHtml = (searchIn === 'answer' || searchIn === 'both') ? this.highlightText(item.answer, regexPattern, true) : item.answer;
                    processedData.push(resItem);
                }
            }
        } 
        // 2. BOOLEAN MODE
        else if (regexEnabled) {
            const parsed = this.parseBooleanQuery(query);
            if (!parsed) return { results: [], message: "" };

            const { codeStr, terms } = parsed;
            const evalFunc = new Function('vals', codeStr);

            terms.forEach(t => {
                const escaped = t.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (t.exact) {
                    const startB = /^\w/.test(t.text) ? '\\b' : '';
                    const endB = /\w$/.test(t.text) ? '\\b' : '';
                    t.regexGlobal = new RegExp(`${startB}${escaped}${endB}`, 'gi');
                } else {
                    t.lower = t.text.toLowerCase();
                }
            });

            const isComplex = query.includes(' OR ') || query.includes(' XOR ');

            for (const item of this.allData) {
                let totalCounts = 0;
                let vals = [];
                let skipItem = false;

                for (const term of terms) {
                    let termCount = 0;
                    const checkField = (textOrig, textLow) => {
                        if (term.exact) {
                            const m = textOrig.match(term.regexGlobal);
                            return m ? m.length : 0;
                        } else {
                            let c = 0, pos = textLow.indexOf(term.lower);
                            while (pos !== -1) { c++; pos = textLow.indexOf(term.lower, pos + 1); }
                            return c;
                        }
                    };

                    if (searchIn === 'question' || searchIn === 'both') termCount += checkField(item.question, item.q_lower);
                    if (searchIn === 'answer' || searchIn === 'both') termCount += checkField(item.answer, item.a_lower);

                    if (!isComplex && termCount === 0) { skipItem = true; break; }
                    vals.push(termCount > 0);
                    totalCounts += termCount;
                }

                if (skipItem) continue;
                let matchFound = isComplex ? false : true;
                if (isComplex) { try { matchFound = evalFunc(vals); } catch (e) { matchFound = false; } }

                if (matchFound) {
                    const resItem = { ...item, matchCount: totalCounts };
                    resItem.questionHtml = (searchIn === 'question' || searchIn === 'both') ? this.highlightText(item.question, terms, false) : item.question;
                    resItem.answerHtml = (searchIn === 'answer' || searchIn === 'both') ? this.highlightText(item.answer, terms, false) : item.answer;
                    processedData.push(resItem);
                }
            }
        }
        // 3. LITERAL MODE
        else {
            const cleanQuery = query.replace(/^[.,!?;:]+|[.,!?;:]+$/g, '');
            const literalTerm = { text: cleanQuery, exact: false, lower: cleanQuery.toLowerCase() };
            
            for (const item of this.allData) {
                let total = 0;
                const countSub = (low) => low.split(literalTerm.lower).length - 1;

                if (searchIn === 'question' || searchIn === 'both') total += countSub(item.q_lower);
                if (searchIn === 'answer' || searchIn === 'both') total += countSub(item.a_lower);

                if (total > 0) {
                    const resItem = { ...item, matchCount: total };
                    resItem.questionHtml = (searchIn === 'question' || searchIn === 'both') ? this.highlightText(item.question, [literalTerm], false) : item.question;
                    resItem.answerHtml = (searchIn === 'answer' || searchIn === 'both') ? this.highlightText(item.answer, [literalTerm], false) : item.answer;
                    processedData.push(resItem);
                }
            }
        }

        // Sorting
        if (sortBy === 'oldest') {
            processedData.sort((a, b) => parseInt(a.id) - parseInt(b.id));
        } else if (sortBy === 'frequency') {
            processedData.sort((a, b) => (b.matchCount - a.matchCount) || (parseInt(b.id) - parseInt(a.id)));
        } else if (sortBy === 'randy') {
            for (let i = processedData.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [processedData[i], processedData[j]] = [processedData[j], processedData[i]];
            }
        } else {
            // Newest
            processedData.sort((a, b) => parseInt(b.id) - parseInt(a.id));
        }

        return { results: processedData, message: "" };
    }
};
