/* ============================================================
   MTG Proxy Builder — app.js
   Static single-page app. No build step required.
   Uses local card data from data/cards.json (synced via GitHub Action).
   ============================================================ */

(() => {
    'use strict';

    // ── Constants ──────────────────────────────────────────
    const CARD_W_MM  = 63;   // standard MTG card width
    const CARD_H_MM  = 88;   // standard MTG card height
    const PAGE_W_MM  = 210;  // A4 width
    const PAGE_H_MM  = 297;  // A4 height
    const COLS        = 3;
    const ROWS        = 3;
    const CARDS_PER_PAGE = COLS * ROWS; // 9

    // Centre the 3×3 grid on the page
    const MARGIN_X = (PAGE_W_MM - COLS * CARD_W_MM) / 2; // 10.5mm
    const MARGIN_Y = (PAGE_H_MM - ROWS * CARD_H_MM) / 2; // 16.5mm

    // Preview canvas scale: mm → CSS‑px (at 72 DPI‑ish for comfortable screen display)
    const PREVIEW_SCALE = 2.5;   // 1mm = 2.5px on screen

    // Scryfall image CDN base
    const IMG_CDN = 'https://cards.scryfall.io';

    // ── State ──────────────────────────────────────────────
    let allImages   = [];   // flat list of base64 image strings (one per card slot)
    let pageCount   = 0;
    let isLoading   = false;

    // Card database: Map<lowercase name → Array<{n, id, s, cn, o, d?}>>
    let cardDB      = null;
    let cardDBReady = false;

    // ── DOM refs (assigned in init) ────────────────────────
    let dom = {};

    // ── Helpers ────────────────────────────────────────────
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

    function getSettings() {
        return {
            cutLines:    dom.cutLineMode.value,      // 'none' | 'corners' | 'grid'
            cutColour:   dom.cutColour.value,
            cutWidth:    parseFloat(dom.cutWidth.value),
            cutStyle:    dom.cutStyle.value,          // 'solid' | 'dashed'
            imageQuality: dom.imageQuality.value,     // 'png' | 'large' | 'normal' | 'border_crop'
        };
    }

    // ── Image URL Builder ──────────────────────────────────
    // Reconstructs Scryfall image URLs from a card's id.
    // Pattern: https://cards.scryfall.io/{quality}/{face}/{id[0]}/{id[1]}/{id}.{ext}
    function buildImageUrl(id, quality, face = 'front') {
        const ext = (quality === 'png') ? 'png' : 'jpg';
        return `${IMG_CDN}/${quality}/${face}/${id[0]}/${id[1]}/${id}.${ext}`;
    }

    // Build a Scryfall prints search URL from oracle_id
    function buildPrintsUri(oracleId) {
        return `https://api.scryfall.com/cards/search?order=released&q=oracleid%3A${oracleId}&unique=prints`;
    }

    // ── Card Database Loader ───────────────────────────────
    async function loadCardDB() {
        dom.dbStatus.textContent = 'Loading card database…';
        dom.btnFetch.disabled = true;

        try {
            const res = await fetch('data/cards.json');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const cards = await res.json();

            // Build lookup map: lowercase name → array of matching entries
            cardDB = new Map();
            for (const card of cards) {
                const key = card.n.toLowerCase();
                if (!cardDB.has(key)) {
                    cardDB.set(key, []);
                }
                cardDB.get(key).push(card);
            }

            cardDBReady = true;
            dom.dbStatus.textContent = `${cards.length.toLocaleString()} cards loaded`;
            dom.btnFetch.disabled = false;

            // Also try to load meta.json for the updated date
            try {
                const metaRes = await fetch('data/meta.json');
                if (metaRes.ok) {
                    const meta = await metaRes.json();
                    const date = new Date(meta.updated).toLocaleDateString();
                    dom.dbStatus.textContent = `${cards.length.toLocaleString()} cards · Updated ${date}`;
                }
            } catch (_) { /* meta.json is optional */ }

        } catch (err) {
            dom.dbStatus.textContent = 'Failed to load card data — using API fallback';
            cardDBReady = false;
            dom.btnFetch.disabled = false;
            console.warn('Card DB load failed:', err);
        }
    }

    // ── Card Lookup ────────────────────────────────────────
    // Look up a card by name (and optional set) from local DB.
    // Returns the matched card entry or null.
    function lookupCard(name, set) {
        if (!cardDB) return null;

        const key = name.toLowerCase();
        const matches = cardDB.get(key);
        if (!matches || !matches.length) return null;

        if (set) {
            // Filter by set code (case-insensitive)
            const setLower = set.toLowerCase();
            const setMatch = matches.find(c => c.s === setLower);
            if (setMatch) return setMatch;
            // If no exact set match, still return first result but warn
            return null;
        }

        // Return first match (Scryfall's "best" version)
        return matches[0];
    }

    // ── Input Parser ───────────────────────────────────────
    //   "4 Lightning Bolt"          → qty 4, name "Lightning Bolt", set null
    //   "Lightning Bolt [2XM]"      → qty 1, name "Lightning Bolt", set "2XM"
    //   "4 Lightning Bolt [2XM]"    → qty 4, name "Lightning Bolt", set "2XM"
    function parseInput(text) {
        const lines = text.split('\n').filter(l => l.trim());
        return lines.map(line => {
            const m = line.trim().match(/^(\d+)?\s*(.*?)(?:\s*\[(\w+)\])?\s*$/);
            if (!m || !m[2].trim()) return null;
            return {
                qty:  parseInt(m[1], 10) || 1,
                name: m[2].trim(),
                set:  m[3] ? m[3].toUpperCase() : null,
            };
        }).filter(Boolean);
    }

    // ── Scryfall API Fallback ──────────────────────────────
    // Used when the local DB is unavailable or a card isn't found locally.
    async function fetchCardFromAPI(name, set) {
        let url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`;
        if (set) url += `&set=${encodeURIComponent(set.toLowerCase())}`;

        const res = await fetch(url);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.details || `Card not found: "${name}"${set ? ` [${set}]` : ''}`);
        }
        return res.json();
    }

    function getImageUrisFromAPICard(card) {
        if (card.image_uris) return [card.image_uris];
        if (card.card_faces) {
            return card.card_faces
                .filter(f => f.image_uris)
                .map(f => f.image_uris);
        }
        return [];
    }

    // ── Image Loader ───────────────────────────────────────
    function getImageData(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'Anonymous';
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width  = img.width;
                c.height = img.height;
                c.getContext('2d').drawImage(img, 0, 0);
                resolve(c.toDataURL('image/jpeg', 0.95));
            };
            img.onerror = () => reject(new Error(`Image load failed: ${url}`));
            img.src = url;
        });
    }

    // ── Get image URLs for a card entry from local DB ──────
    function getImageUrlsForCard(card, quality) {
        const urls = [];
        if (card.d) {
            // Double-faced card: front and back
            urls.push(buildImageUrl(card.id, quality, 'front'));
            urls.push(buildImageUrl(card.id, quality, 'back'));
        } else {
            urls.push(buildImageUrl(card.id, quality, 'front'));
        }
        return urls;
    }

    // ── Fetch & Build Image List ───────────────────────────
    async function fetchAllCards() {
        const text = dom.cardList.value.trim();
        if (!text) return;

        const entries = parseInput(text);
        if (!entries.length) {
            showError('No valid card entries found.');
            return;
        }

        isLoading = true;
        allImages = [];
        clearErrors();
        setProgress(0, 'Starting…');
        dom.progressContainer.classList.add('active');
        dom.btnFetch.disabled = true;
        dom.btnDownload.disabled = true;

        const settings = getSettings();
        const quality  = settings.imageQuality;

        let done = 0;
        const total = entries.reduce((s, e) => s + e.qty, 0);

        for (const entry of entries) {
            try {
                let imageUrls = [];

                // Try local DB first
                const localCard = lookupCard(entry.name, entry.set);

                if (localCard) {
                    imageUrls = getImageUrlsForCard(localCard, quality);
                } else if (cardDBReady && entry.set) {
                    // Name found but set doesn't match — try without set filter
                    const fallbackCard = lookupCard(entry.name, null);
                    if (fallbackCard) {
                        addError(`"${entry.name}" not found in set [${entry.set}], using ${fallbackCard.s.toUpperCase()} instead`);
                        imageUrls = getImageUrlsForCard(fallbackCard, quality);
                    }
                }

                if (!imageUrls.length) {
                    // Fallback: try Scryfall API
                    if (cardDBReady) {
                        addError(`"${entry.name}" not found in local data, trying API…`);
                    }
                    await sleep(80); // Scryfall rate limit
                    const apiCard = await fetchCardFromAPI(entry.name, entry.set);
                    const faces = getImageUrisFromAPICard(apiCard);
                    for (const face of faces) {
                        const url = face[quality] || face.large || face.normal;
                        imageUrls.push(url);
                    }
                }

                if (!imageUrls.length) {
                    addError(`No images available for "${entry.name}"`);
                    done += entry.qty;
                    setProgress(done / total);
                    continue;
                }

                // Download pixel data for each image URL
                const faceDataList = [];
                for (const url of imageUrls) {
                    const data = await getImageData(url);
                    faceDataList.push(data);
                }

                // Expand by qty — each copy adds all faces
                for (let i = 0; i < entry.qty; i++) {
                    for (const data of faceDataList) {
                        allImages.push(data);
                    }
                    done++;
                    setProgress(done / total, `Fetched ${done}/${total}…`);
                }
            } catch (err) {
                addError(err.message);
                done += entry.qty;
                setProgress(done / total);
            }
        }

        isLoading = false;
        dom.progressContainer.classList.remove('active');
        dom.btnFetch.disabled = false;

        if (allImages.length) {
            renderPreview();
            dom.btnDownload.disabled = false;
        } else {
            showEmptyState();
        }
    }

    // ── Preview Rendering (Canvas) ─────────────────────────
    async function renderPreview() {
        const settings = getSettings();
        pageCount = Math.ceil(allImages.length / CARDS_PER_PAGE);

        // Update stats
        dom.statsBar.style.display = 'flex';
        dom.statCards.textContent  = allImages.length;
        dom.statPages.textContent  = pageCount;

        // Clear previous previews
        dom.pageContainer.innerHTML = '';

        for (let p = 0; p < pageCount; p++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'page-wrapper';

            const label = document.createElement('div');
            label.className = 'page-label';
            label.textContent = `Page ${p + 1} of ${pageCount}`;

            const canvas = document.createElement('canvas');
            canvas.className = 'page-canvas';
            canvas.width  = PAGE_W_MM * PREVIEW_SCALE;
            canvas.height = PAGE_H_MM * PREVIEW_SCALE;
            // For crisp rendering on high-DPI, keep CSS size half of canvas size
            canvas.style.width  = `${PAGE_W_MM * PREVIEW_SCALE / 2}px`;
            canvas.style.height = `${PAGE_H_MM * PREVIEW_SCALE / 2}px`;

            wrapper.appendChild(label);
            wrapper.appendChild(canvas);
            dom.pageContainer.appendChild(wrapper);

            await drawPage(canvas, p, settings);
        }

        dom.emptyState.style.display = 'none';
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload  = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    async function drawPage(canvas, pageIndex, settings) {
        const ctx = canvas.getContext('2d');
        const s   = PREVIEW_SCALE;

        // White background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const startIdx = pageIndex * CARDS_PER_PAGE;

        // Draw cards
        let drawn = 0;
        for (let row = 0; row < ROWS; row++) {
            for (let col = 0; col < COLS; col++) {
                const idx = startIdx + row * COLS + col;
                if (idx >= allImages.length) break;

                const x = (MARGIN_X + col * CARD_W_MM) * s;
                const y = (MARGIN_Y + row * CARD_H_MM) * s;
                const w = CARD_W_MM * s;
                const h = CARD_H_MM * s;

                try {
                    const img = await loadImage(allImages[idx]);
                    ctx.drawImage(img, x, y, w, h);
                } catch (_) { /* skip if image failed to decode */ }
                drawn++;
            }
        }

        // Draw cut lines on top
        if (settings.cutLines !== 'none' && drawn > 0) {
            drawCutLinesCanvas(ctx, s, settings, startIdx);
        }
    }

    function drawCutLinesCanvas(ctx, s, settings, startIdx) {
        ctx.save();
        ctx.strokeStyle = settings.cutColour;
        ctx.lineWidth   = settings.cutWidth * s;

        if (settings.cutStyle === 'dashed') {
            ctx.setLineDash([3 * s, 3 * s]);
        } else {
            ctx.setLineDash([]);
        }

        const cardsOnPage = Math.min(allImages.length - startIdx, CARDS_PER_PAGE);
        const filledCols = Math.min(cardsOnPage, COLS);
        const filledRows = Math.ceil(cardsOnPage / COLS);

        if (settings.cutLines === 'grid') {
            const lastRowCols = cardsOnPage - (filledRows - 1) * COLS;

            // Horizontal lines
            for (let row = 0; row <= filledRows; row++) {
                const y = (MARGIN_Y + row * CARD_H_MM) * s;
                // Bottom line of last row only spans its columns
                const cols = (row === filledRows) ? lastRowCols : filledCols;
                ctx.beginPath();
                ctx.moveTo(MARGIN_X * s, y);
                ctx.lineTo((MARGIN_X + cols * CARD_W_MM) * s, y);
                ctx.stroke();
            }

            // Vertical lines
            for (let col = 0; col <= filledCols; col++) {
                const x = (MARGIN_X + col * CARD_W_MM) * s;
                // If this column goes past the last row's cards, stop one row early
                const rowSpan = (col <= lastRowCols) ? filledRows : (filledRows - 1);
                ctx.beginPath();
                ctx.moveTo(x, MARGIN_Y * s);
                ctx.lineTo(x, (MARGIN_Y + rowSpan * CARD_H_MM) * s);
                ctx.stroke();
            }
        } else if (settings.cutLines === 'corners') {
            const markLen = 4 * s; // 4mm corner marks
            for (let i = 0; i < cardsOnPage; i++) {
                const row = Math.floor(i / COLS);
                const col = i % COLS;
                const x1 = (MARGIN_X + col * CARD_W_MM) * s;
                const y1 = (MARGIN_Y + row * CARD_H_MM) * s;
                const x2 = x1 + CARD_W_MM * s;
                const y2 = y1 + CARD_H_MM * s;
                drawCornerMarks(ctx, x1, y1, x2, y2, markLen);
            }
        }
        ctx.restore();
    }

    function drawCornerMarks(ctx, x1, y1, x2, y2, len) {
        // Top-left
        ctx.beginPath(); ctx.moveTo(x1 - len, y1); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, y1 - len); ctx.lineTo(x1, y1); ctx.stroke();
        // Top-right
        ctx.beginPath(); ctx.moveTo(x2, y1); ctx.lineTo(x2 + len, y1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, y1 - len); ctx.lineTo(x2, y1); ctx.stroke();
        // Bottom-left
        ctx.beginPath(); ctx.moveTo(x1 - len, y2); ctx.lineTo(x1, y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, y2); ctx.lineTo(x1, y2 + len); ctx.stroke();
        // Bottom-right
        ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 + len, y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2, y2 + len); ctx.stroke();
    }

    // ── PDF Generation ─────────────────────────────────────
    function generatePDF() {
        if (!allImages.length) return;

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
        const settings = getSettings();
        const pages = Math.ceil(allImages.length / CARDS_PER_PAGE);

        for (let p = 0; p < pages; p++) {
            if (p > 0) doc.addPage();

            const startIdx = p * CARDS_PER_PAGE;

            // Draw cards
            for (let i = 0; i < CARDS_PER_PAGE; i++) {
                const idx = startIdx + i;
                if (idx >= allImages.length) break;

                const row = Math.floor(i / COLS);
                const col = i % COLS;
                const x = MARGIN_X + col * CARD_W_MM;
                const y = MARGIN_Y + row * CARD_H_MM;

                doc.addImage(allImages[idx], 'JPEG', x, y, CARD_W_MM, CARD_H_MM);
            }

            // Draw cut lines
            if (settings.cutLines !== 'none') {
                drawCutLinesPDF(doc, settings, startIdx);
            }
        }

        doc.save('proxies.pdf');
    }

    function drawCutLinesPDF(doc, settings, startIdx) {
        // Parse hex colour to RGB
        const hex = settings.cutColour.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);

        doc.setDrawColor(r, g, b);
        doc.setLineWidth(settings.cutWidth);

        if (settings.cutStyle === 'dashed') {
            doc.setLineDashPattern([2, 2], 0);
        } else {
            doc.setLineDashPattern([], 0);
        }

        const cardsOnPage = Math.min(allImages.length - startIdx, CARDS_PER_PAGE);
        const filledCols = Math.min(cardsOnPage, COLS);
        const filledRows = Math.ceil(cardsOnPage / COLS);

        if (settings.cutLines === 'grid') {
            const lastRowCols = cardsOnPage - (filledRows - 1) * COLS;

            // Horizontal lines
            for (let row = 0; row <= filledRows; row++) {
                const y = MARGIN_Y + row * CARD_H_MM;
                const cols = (row === filledRows) ? lastRowCols : filledCols;
                doc.line(MARGIN_X, y, MARGIN_X + cols * CARD_W_MM, y);
            }

            // Vertical lines
            for (let col = 0; col <= filledCols; col++) {
                const x = MARGIN_X + col * CARD_W_MM;
                const rowSpan = (col <= lastRowCols) ? filledRows : (filledRows - 1);
                doc.line(x, MARGIN_Y, x, MARGIN_Y + rowSpan * CARD_H_MM);
            }
        } else if (settings.cutLines === 'corners') {
            const markLen = 4; // 4mm
            for (let i = 0; i < cardsOnPage; i++) {
                const row = Math.floor(i / COLS);
                const col = i % COLS;
                const x1 = MARGIN_X + col * CARD_W_MM;
                const y1 = MARGIN_Y + row * CARD_H_MM;
                const x2 = x1 + CARD_W_MM;
                const y2 = y1 + CARD_H_MM;

                // Top-left
                doc.line(x1 - markLen, y1, x1, y1);
                doc.line(x1, y1 - markLen, x1, y1);
                // Top-right
                doc.line(x2, y1, x2 + markLen, y1);
                doc.line(x2, y1 - markLen, x2, y1);
                // Bottom-left
                doc.line(x1 - markLen, y2, x1, y2);
                doc.line(x1, y2, x1, y2 + markLen);
                // Bottom-right
                doc.line(x2, y2, x2 + markLen, y2);
                doc.line(x2, y2, x2, y2 + markLen);
            }
        }

        // Reset dash
        doc.setLineDashPattern([], 0);
    }

    // ── UI Helpers ─────────────────────────────────────────
    function setProgress(ratio, text) {
        const pct = Math.round(ratio * 100);
        dom.progressFill.style.width = `${pct}%`;
        if (text) dom.progressText.textContent = text;
    }

    function clearErrors() {
        dom.errorLog.innerHTML = '';
    }

    function addError(msg) {
        const div = document.createElement('div');
        div.className = 'error-item';
        div.textContent = msg;
        dom.errorLog.appendChild(div);
    }

    function showError(msg) {
        clearErrors();
        addError(msg);
    }

    function showEmptyState() {
        dom.emptyState.style.display = 'flex';
        dom.statsBar.style.display   = 'none';
        dom.pageContainer.innerHTML  = '';
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function clearAll() {
        allImages = [];
        pageCount = 0;
        dom.cardList.value = '';
        clearErrors();
        dom.btnDownload.disabled = true;
        dom.statsBar.style.display = 'none';
        dom.pageContainer.innerHTML = '';
        dom.emptyState.style.display = 'flex';
    }

    // ── Settings ↔ Preview live update ─────────────────────
    function onSettingsChange() {
        if (allImages.length) renderPreview();
    }

    // ── Init ───────────────────────────────────────────────
    function init() {
        dom = {
            cardList:           $('#cardList'),
            btnFetch:           $('#btnFetch'),
            btnDownload:        $('#btnDownload'),
            btnClear:           $('#btnClear'),
            cutLineMode:        $('#cutLineMode'),
            cutColour:          $('#cutColour'),
            cutWidth:           $('#cutWidth'),
            cutWidthValue:      $('#cutWidthValue'),
            cutStyle:           $('#cutStyle'),
            imageQuality:       $('#imageQuality'),
            progressContainer:  $('#progressContainer'),
            progressFill:       $('#progressFill'),
            progressText:       $('#progressText'),
            errorLog:           $('#errorLog'),
            statsBar:           $('#statsBar'),
            statCards:          $('#statCards'),
            statPages:          $('#statPages'),
            pageContainer:      $('#pageContainer'),
            emptyState:         $('#emptyState'),
            dbStatus:           $('#dbStatus'),
        };

        // Buttons
        dom.btnFetch.addEventListener('click', fetchAllCards);
        dom.btnDownload.addEventListener('click', generatePDF);
        dom.btnClear.addEventListener('click', clearAll);

        // Range label update
        dom.cutWidth.addEventListener('input', () => {
            dom.cutWidthValue.textContent = `${dom.cutWidth.value}mm`;
            onSettingsChange();
        });

        // Live preview update for settings (except imageQuality which requires re-fetch)
        ['cutLineMode', 'cutColour', 'cutStyle'].forEach(id => {
            dom[id].addEventListener('change', onSettingsChange);
        });
        dom.cutColour.addEventListener('input', onSettingsChange);

        // Load the local card database
        loadCardDB();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
