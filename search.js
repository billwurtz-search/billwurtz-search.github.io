const SearchEngine = {
    allData: [],
    isLoaded: false,

    // -- Data Loading --
    async loadAllData(fileList) {
        console.log("Loading data...");
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
            console.log(`Loaded ${this.allData.length} entries.`);
            return this.allData.length;

        } catch (err) {
            console.error("Critical error loading data:", err);
            throw err;
        }
    },

    // -- Query Parsing --
    parseBooleanQuery(query) {
        const regex = /"([^"]+)"|'([^']+)'|([^\s"']+)/g;
        let match;
        const tokens = [];
        
        while ((match = regex.exec(query)) !== null) {
            if (match[1] !== undefined) tokens.push({ val: match[1], quoted: true });
            else if (match[2] !== undefined) tokens.push({ val: match[2], quoted: true });
            else tokens.push({ val: match[3], quoted: false });
        }

        if (tokens.length === 0) return null;

        let expressionParts = [];
        let terms = [];
        
        tokens.forEach(tokenObj => {
            const rawVal = tokenObj.val;
            
            if (!tokenObj.quoted && ['AND', 'OR', 'XOR'].includes(rawVal)) {
                if (rawVal === 'AND') expressionParts.push('&&');
                if (rawVal === 'OR') expressionParts.push('||');
                if (rawVal === 'XOR') expressionParts.push('!='); 
            } else if (!tokenObj.quoted && rawVal === '(') {
                expressionParts.push('(');
            } else if (!tokenObj.quoted && rawVal === ')') {
                expressionParts.push(')');
            } else {
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
        } catch (e) {
            return null;
        }
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
                    regex = new RegExp(`\\b${escaped}\\b`, 'gi');
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

        // Regex Mode
        if (regexEnabled && query.startsWith("REGEX=")) {
            const regexStr = query.substring(6);
            let regexPattern;
            try {
                regexPattern = new RegExp(regexStr, 'g'); 
            } catch (e) {
                return { results: [], message: "Invalid regex." };
            }

            for (const item of this.allData) {
                let count = 0;
                
                const countMatches = (str) => {
                    if (!str) return 0;
                    regexPattern.lastIndex = 0; 
                    const matches = str.match(regexPattern);
                    return matches ? matches.length : 0;
                };

                if (searchIn === 'question' || searchIn === 'both') {
                    count += countMatches(item.question);
                }
                if (searchIn === 'answer' || searchIn === 'both') {
                    count += countMatches(item.answer);
                }

                if (count > 0) {
                    const resItem = { ...item };
                    resItem.matchCount = count;
                    regexPattern.lastIndex = 0; 
                    
                    // Conditional Highlighting
                    resItem.questionHtml = (searchIn === 'question' || searchIn === 'both') ? this.highlightText(item.question, regexPattern, true) : item.question;
                    regexPattern.lastIndex = 0;
                    resItem.answerHtml = (searchIn === 'answer' || searchIn === 'both') ? this.highlightText(item.answer, regexPattern, true) : item.answer;
                    
                    processedData.push(resItem);
                }
            }

        } 
        // Boolean mode
        else if (regexEnabled) {
            const parsed = this.parseBooleanQuery(query);
            if (!parsed) return { results: [], message: "" };

            const { codeStr, terms } = parsed;
            const evalFunc = new Function('vals', codeStr);

            terms.forEach(t => {
                if (t.exact) {
                    const escaped = t.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    t.regexGlobal = new RegExp(`\\b${escaped}\\b`, 'gi');
                } else {
                    t.lower = t.text.toLowerCase();
                }
            });

            const isComplex = query.includes(' OR ') || query.includes(' XOR ');

            for (const item of this.allData) {
                const qText = item.question || "";
                const aText = item.answer || "";
                const qLower = item.q_lower;
                const aLower = item.a_lower;

                let matchFound = false;
                let totalCounts = 0;
                let vals = [];

                for (const term of terms) {
                    let termCount = 0;

                    const checkField = (textOriginal, textLower) => {
                        if (term.exact) {
                            const matches = textOriginal.match(term.regexGlobal);
                            return matches ? matches.length : 0;
                        } else {
                            let c = 0;
                            let pos = textLower.indexOf(term.lower);
                            while (pos !== -1) {
                                c++;
                                pos = textLower.indexOf(term.lower, pos + 1);
                            }
                            return c;
                        }
                    };

                    if (searchIn === 'question' || searchIn === 'both') {
                        termCount += checkField(qText, qLower);
                    }
                    if (searchIn === 'answer' || searchIn === 'both') {
                        termCount += checkField(aText, aLower);
                    }

                    if (!isComplex) {
                        if (termCount === 0) {
                            matchFound = false;
                            vals = null;
                            break;
                        }
                        matchFound = true;
                    } else {
                        vals.push(termCount > 0);
                    }
                    totalCounts += termCount;
                }

                if (isComplex && vals) {
                    try {
                        matchFound = evalFunc(vals);
                    } catch (e) { matchFound = false; }
                }

                if (matchFound) {
                    const resItem = { ...item };
                    resItem.matchCount = totalCounts;
                    
                    // Conditional Highlighting
                    resItem.questionHtml = (searchIn === 'question' || searchIn === 'both') ? this.highlightText(item.question, terms, false) : item.question;
                    resItem.answerHtml = (searchIn === 'answer' || searchIn === 'both') ? this.highlightText(item.answer, terms, false) : item.answer;
                    
                    processedData.push(resItem);
                }
            }
        }
        // Literal Mode
        else {
            const literalTerm = { text: query, exact: false, lower: query.toLowerCase() };
            const terms = [literalTerm];

            for (const item of this.allData) {
                const qText = item.question || "";
                const aText = item.answer || "";
                const qLower = item.q_lower;
                const aLower = item.a_lower;

                let totalCounts = 0;
                
                const checkField = (textLower) => {
                    let c = 0;
                    let pos = textLower.indexOf(literalTerm.lower);
                    while (pos !== -1) {
                        c++;
                        pos = textLower.indexOf(literalTerm.lower, pos + 1);
                    }
                    return c;
                };

                if (searchIn === 'question' || searchIn === 'both') {
                    totalCounts += checkField(qLower);
                }
                if (searchIn === 'answer' || searchIn === 'both') {
                    totalCounts += checkField(aLower);
                }

                if (totalCounts > 0) {
                    const resItem = { ...item };
                    resItem.matchCount = totalCounts;
                    
                    // Highlighting
                    resItem.questionHtml = (searchIn === 'question' || searchIn === 'both') ? this.highlightText(qText, terms, false) : qText;
                    resItem.answerHtml = (searchIn === 'answer' || searchIn === 'both') ? this.highlightText(aText, terms, false) : aText;
                    
                    processedData.push(resItem);
                }
            }
        }

        // Sorting
        if (sortBy === 'oldest') {
            processedData.sort((a, b) => parseInt(a.id) - parseInt(b.id));
        } else if (sortBy === 'frequency') {
            processedData.sort((a, b) => {
                if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
                return parseInt(b.id) - parseInt(a.id);
            });
            // Newest
        } else {
            processedData.sort((a, b) => parseInt(b.id) - parseInt(a.id));
        }

        return { results: processedData, message: "" };
    }
};
