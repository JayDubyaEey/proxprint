/* ============================================================
   MTG Proxy Builder — app.js
   Static single-page app. No build step required.
   Uses local card data from data/cards.json (synced via GitHub Action).

   Flow:
     1. Load card DB → build name index + oracle index
     2. User enters card list → clicks "Load Cards"
     3. Card management list appears with thumbnails + variant picker
     4. User selects desired variants per card
     5. "Generate Preview" → downloads full-quality images → canvas preview
     6. "Download PDF" → generates and saves PDF
   ============================================================ */

(() => {
    'use strict';

    // ── Constants ──────────────────────────────────────────
    const CARD_W_MM  = 63;
    const CARD_H_MM  = 88;
    const PAGE_W_MM  = 210;
    const PAGE_H_MM  = 297;
    const COLS        = 3;
    const ROWS        = 3;
    const CARDS_PER_PAGE = COLS * ROWS;
    const MARGIN_X = (PAGE_W_MM - COLS * CARD_W_MM) / 2;
    const MARGIN_Y = (PAGE_H_MM - ROWS * CARD_H_MM) / 2;
    const PREVIEW_SCALE = 2.5;
    const IMG_CDN = 'https://cards.scryfall.io';

    // ── State ──────────────────────────────────────────────
    let allImages   = [];      // flat base64 list (built from cardSlots during generate)
    let pageCount   = 0;
    let isLoading   = false;
    let currentView = 'empty'; // 'empty' | 'cards' | 'preview'

    // Card database
    let cardDB       = null;   // Map<lowercase name → Card[]>
    let oracleIndex  = null;   // Map<oracle_id → Card[]>
    let cardDBReady  = false;

    // Card slots: the user's card list with variant selection
    // Each: { name, qty, oracleId, selected: Card, variants: Card[], error?: string }
    let cardSlots = [];

    // Currently open popover slot index (-1 = none)
    let openPopoverIdx = -1;

    // ── DOM refs ───────────────────────────────────────────
    let dom = {};
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

    // ── Settings ───────────────────────────────────────────
    function getSettings() {
        return {
            cutLines:     dom.cutLineMode.value,
            cutColour:    dom.cutColour.value,
            cutWidth:     parseFloat(dom.cutWidth.value),
            cutStyle:     dom.cutStyle.value,
            imageQuality: dom.imageQuality.value,
        };
    }

    // ── Image URL Builder ──────────────────────────────────
    function buildImageUrl(id, quality, face = 'front') {
        const ext = (quality === 'png') ? 'png' : 'jpg';
        return `${IMG_CDN}/${quality}/${face}/${id[0]}/${id[1]}/${id}.${ext}`;
    }

    // ── Card Database Loader ───────────────────────────────
    async function loadCardDB() {
        dom.dbStatus.textContent = 'Loading card database…';
        dom.btnLoadCards.disabled = true;

        try {
            const res = await fetch('data/cards.json');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const cards = await res.json();

            // Build name lookup: lowercase name → Card[]
            cardDB = new Map();
            // Build oracle index: oracle_id → Card[]
            oracleIndex = new Map();

            for (const card of cards) {
                // Name index
                const key = card.n.toLowerCase();
                if (!cardDB.has(key)) cardDB.set(key, []);
                cardDB.get(key).push(card);

                // Oracle index
                if (card.o) {
                    if (!oracleIndex.has(card.o)) oracleIndex.set(card.o, []);
                    oracleIndex.get(card.o).push(card);
                }
            }

            cardDBReady = true;
            dom.dbStatus.textContent = `${cards.length.toLocaleString()} cards loaded`;
            dom.btnLoadCards.disabled = false;

            try {
                const metaRes = await fetch('data/meta.json');
                if (metaRes.ok) {
                    const meta = await metaRes.json();
                    const date = new Date(meta.updated).toLocaleDateString();
                    dom.dbStatus.textContent = `${cards.length.toLocaleString()} cards · Updated ${date}`;
                }
            } catch (_) {}

        } catch (err) {
            dom.dbStatus.textContent = 'Failed to load card data — using API fallback';
            cardDBReady = false;
            dom.btnLoadCards.disabled = false;
            console.warn('Card DB load failed:', err);
        }
    }

    // ── Card Lookup ────────────────────────────────────────
    function lookupCard(name, set) {
        if (!cardDB) return null;
        const key = name.toLowerCase();
        const matches = cardDB.get(key);
        if (!matches || !matches.length) return null;

        if (set) {
            const setLower = set.toLowerCase();
            const setMatch = matches.find(c => c.s === setLower);
            if (setMatch) return setMatch;
            return null;
        }
        return matches[0];
    }

    // Get all unique-art variants for a card via oracle_id
    function getVariants(oracleId) {
        if (!oracleIndex || !oracleId) return [];
        return oracleIndex.get(oracleId) || [];
    }

    // ── Input Parser ───────────────────────────────────────
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

    // ── Image Helpers ──────────────────────────────────────
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

    function getImageUrlsForCard(card, quality) {
        const urls = [];
        if (card.d) {
            urls.push(buildImageUrl(card.id, quality, 'front'));
            urls.push(buildImageUrl(card.id, quality, 'back'));
        } else {
            urls.push(buildImageUrl(card.id, quality, 'front'));
        }
        return urls;
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload  = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    // ================================================================
    //  STAGE 1 — Load Cards (parse input → build cardSlots → render list)
    // ================================================================

    async function loadCards() {
        const text = dom.cardList.value.trim();
        if (!text) return;

        const entries = parseInput(text);
        if (!entries.length) {
            showError('No valid card entries found.');
            return;
        }

        clearErrors();
        cardSlots = [];

        for (const entry of entries) {
            let selected = null;
            let variants = [];
            let error = null;

            // Try local DB
            selected = lookupCard(entry.name, entry.set);

            if (!selected && cardDBReady && entry.set) {
                selected = lookupCard(entry.name, null);
                if (selected) {
                    addError(`"${entry.name}" not found in set [${entry.set}], using ${selected.s.toUpperCase()}`);
                }
            }

            if (!selected && !cardDBReady) {
                // API fallback — get card info, create a synthetic entry
                try {
                    await sleep(80);
                    const apiCard = await fetchCardFromAPI(entry.name, entry.set);
                    selected = {
                        n:  apiCard.name,
                        id: apiCard.id,
                        s:  apiCard.set,
                        cn: apiCard.collector_number,
                        o:  apiCard.oracle_id,
                        d:  apiCard.card_faces && apiCard.card_faces.some(f => f.image_uris) ? 1 : undefined,
                    };
                } catch (e) {
                    error = e.message;
                    addError(e.message);
                }
            }

            if (!selected && cardDBReady) {
                error = `Card not found: "${entry.name}"`;
                addError(error);
            }

            if (selected) {
                variants = getVariants(selected.o);
                // If variants is empty (API fallback, no oracle index), at least include selected
                if (!variants.length) variants = [selected];
            }

            cardSlots.push({
                name:     entry.name,
                qty:      entry.qty,
                oracleId: selected ? selected.o : null,
                selected: selected,
                variants: variants,
                error:    error,
            });
        }

        showView('cards');
        renderCardList();
    }

    // ================================================================
    //  Card Management List — Rendering
    // ================================================================

    function renderCardList() {
        const container = dom.cardListView;
        container.innerHTML = '';

        // Stats summary
        const totalCards = cardSlots.reduce((s, slot) => s + (slot.selected ? slot.qty : 0), 0);
        const totalFaces = cardSlots.reduce((s, slot) => {
            if (!slot.selected) return s;
            const faces = slot.selected.d ? 2 : 1;
            return s + slot.qty * faces;
        }, 0);
        const totalPages = Math.ceil(totalFaces / CARDS_PER_PAGE);

        dom.cardListStats.innerHTML =
            `<span><strong>${totalCards}</strong> cards</span>` +
            `<span class="cl-stats-sep">·</span>` +
            `<span><strong>${totalFaces}</strong> faces</span>` +
            `<span class="cl-stats-sep">·</span>` +
            `<span><strong>${totalPages}</strong> page${totalPages !== 1 ? 's' : ''}</span>`;

        // Render each card row
        cardSlots.forEach((slot, idx) => {
            const row = document.createElement('div');
            row.className = 'cl-row' + (slot.error ? ' cl-row-error' : '');
            row.dataset.idx = idx;

            if (slot.error && !slot.selected) {
                // Error row — no card found
                row.innerHTML =
                    `<div class="cl-row-info">` +
                        `<span class="cl-qty">${slot.qty}×</span>` +
                        `<span class="cl-name">${esc(slot.name)}</span>` +
                        `<span class="cl-error-badge">Not found</span>` +
                    `</div>`;
            } else if (slot.selected) {
                const card = slot.selected;
                const thumbUrl = buildImageUrl(card.id, 'normal', 'front');
                const variantCount = slot.variants.length;

                row.innerHTML =
                    `<div class="cl-thumb-wrap" data-idx="${idx}">` +
                        `<img class="cl-thumb" src="${thumbUrl}" alt="${esc(card.n)}" loading="lazy">` +
                        (variantCount > 1
                            ? `<button class="cl-variant-btn" data-idx="${idx}" title="Choose variant">${variantCount} arts</button>`
                            : '') +
                    `</div>` +
                    `<div class="cl-row-info">` +
                        `<span class="cl-qty">${slot.qty}×</span>` +
                        `<span class="cl-name">${esc(card.n)}</span>` +
                        `<span class="cl-set">${card.s.toUpperCase()} #${card.cn}</span>` +
                        (card.d ? `<span class="cl-dfc-badge">DFC</span>` : '') +
                    `</div>`;
            }

            container.appendChild(row);
        });

        // Attach event listeners for variant buttons and thumbnails
        container.querySelectorAll('.cl-variant-btn, .cl-thumb-wrap').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(el.dataset.idx, 10);
                if (openPopoverIdx === idx) {
                    closePopover();
                } else {
                    openVariantPopover(idx);
                }
            });
        });
    }

    function esc(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ================================================================
    //  Variant Popover
    // ================================================================

    function openVariantPopover(slotIdx) {
        closePopover();

        const slot = cardSlots[slotIdx];
        if (!slot || slot.variants.length <= 1) return;

        openPopoverIdx = slotIdx;

        const rowEl = dom.cardListView.querySelector(`.cl-row[data-idx="${slotIdx}"]`);
        if (!rowEl) return;

        const popover = document.createElement('div');
        popover.className = 'variant-popover';
        popover.id = 'variantPopover';

        // Header
        const header = document.createElement('div');
        header.className = 'vp-header';
        header.innerHTML =
            `<span class="vp-title">${esc(slot.selected.n)}</span>` +
            `<span class="vp-count">${slot.variants.length} variants</span>` +
            `<button class="vp-close" aria-label="Close">&times;</button>`;
        popover.appendChild(header);

        // Grid of variant options
        const grid = document.createElement('div');
        grid.className = 'vp-grid';

        for (const variant of slot.variants) {
            const option = document.createElement('div');
            const isSelected = variant.id === slot.selected.id;
            option.className = 'vp-option' + (isSelected ? ' vp-option-selected' : '');

            const thumbUrl = buildImageUrl(variant.id, 'normal', 'front');
            option.innerHTML =
                `<img class="vp-thumb" src="${thumbUrl}" alt="${esc(variant.n)}" loading="lazy">` +
                `<div class="vp-label">${variant.s.toUpperCase()} #${variant.cn}</div>`;

            option.addEventListener('click', () => {
                selectVariant(slotIdx, variant);
            });

            grid.appendChild(option);
        }

        popover.appendChild(grid);
        rowEl.appendChild(popover);

        // Close button
        popover.querySelector('.vp-close').addEventListener('click', (e) => {
            e.stopPropagation();
            closePopover();
        });

        // Close on outside click (deferred to avoid immediate trigger)
        requestAnimationFrame(() => {
            document.addEventListener('click', handleOutsideClick);
            document.addEventListener('keydown', handleEscKey);
        });
    }

    function closePopover() {
        const existing = document.getElementById('variantPopover');
        if (existing) existing.remove();
        openPopoverIdx = -1;
        document.removeEventListener('click', handleOutsideClick);
        document.removeEventListener('keydown', handleEscKey);
    }

    function handleOutsideClick(e) {
        const popover = document.getElementById('variantPopover');
        if (popover && !popover.contains(e.target)) {
            closePopover();
        }
    }

    function handleEscKey(e) {
        if (e.key === 'Escape') closePopover();
    }

    function selectVariant(slotIdx, variant) {
        const slot = cardSlots[slotIdx];
        slot.selected = variant;
        slot.oracleId = variant.o;
        closePopover();
        renderCardList();
    }

    // ================================================================
    //  STAGE 2 — Generate Preview (download images → canvas pages)
    // ================================================================

    async function generatePreview() {
        if (!cardSlots.length) return;

        const validSlots = cardSlots.filter(s => s.selected);
        if (!validSlots.length) {
            showError('No valid cards to preview.');
            return;
        }

        isLoading = true;
        allImages = [];
        clearErrors();
        setProgress(0, 'Downloading images…');
        dom.progressContainer.classList.add('active');
        dom.btnGenerate.disabled = true;
        dom.btnDownload.disabled = true;

        const quality = getSettings().imageQuality;
        let done = 0;
        const total = validSlots.reduce((s, slot) => s + slot.qty, 0);

        for (const slot of validSlots) {
            try {
                const imageUrls = getImageUrlsForCard(slot.selected, quality);
                const faceDataList = [];

                for (const url of imageUrls) {
                    const data = await getImageData(url);
                    faceDataList.push(data);
                }

                for (let i = 0; i < slot.qty; i++) {
                    for (const data of faceDataList) {
                        allImages.push(data);
                    }
                    done++;
                    setProgress(done / total, `Downloading ${done}/${total}…`);
                }
            } catch (err) {
                addError(`${slot.name}: ${err.message}`);
                done += slot.qty;
                setProgress(done / total);
            }
        }

        isLoading = false;
        dom.progressContainer.classList.remove('active');
        dom.btnGenerate.disabled = false;

        if (allImages.length) {
            showView('preview');
            renderPreview();
            dom.btnDownload.disabled = false;
        } else {
            showError('No images could be loaded.');
        }
    }

    // ── Preview Rendering (Canvas) ─────────────────────────
    async function renderPreview() {
        const settings = getSettings();
        pageCount = Math.ceil(allImages.length / CARDS_PER_PAGE);

        dom.statsBar.style.display = 'flex';
        dom.statCards.textContent  = allImages.length;
        dom.statPages.textContent  = pageCount;

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
            canvas.style.width  = `${PAGE_W_MM * PREVIEW_SCALE / 2}px`;
            canvas.style.height = `${PAGE_H_MM * PREVIEW_SCALE / 2}px`;

            wrapper.appendChild(label);
            wrapper.appendChild(canvas);
            dom.pageContainer.appendChild(wrapper);

            await drawPage(canvas, p, settings);
        }
    }

    async function drawPage(canvas, pageIndex, settings) {
        const ctx = canvas.getContext('2d');
        const s   = PREVIEW_SCALE;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const startIdx = pageIndex * CARDS_PER_PAGE;
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
                } catch (_) {}
                drawn++;
            }
        }

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
            for (let row = 0; row <= filledRows; row++) {
                const y = (MARGIN_Y + row * CARD_H_MM) * s;
                const cols = (row === filledRows) ? lastRowCols : filledCols;
                ctx.beginPath();
                ctx.moveTo(MARGIN_X * s, y);
                ctx.lineTo((MARGIN_X + cols * CARD_W_MM) * s, y);
                ctx.stroke();
            }
            for (let col = 0; col <= filledCols; col++) {
                const x = (MARGIN_X + col * CARD_W_MM) * s;
                const rowSpan = (col <= lastRowCols) ? filledRows : (filledRows - 1);
                ctx.beginPath();
                ctx.moveTo(x, MARGIN_Y * s);
                ctx.lineTo(x, (MARGIN_Y + rowSpan * CARD_H_MM) * s);
                ctx.stroke();
            }
        } else if (settings.cutLines === 'corners') {
            const markLen = 4 * s;
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
        ctx.beginPath(); ctx.moveTo(x1 - len, y1); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, y1 - len); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, y1); ctx.lineTo(x2 + len, y1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, y1 - len); ctx.lineTo(x2, y1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1 - len, y2); ctx.lineTo(x1, y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, y2); ctx.lineTo(x1, y2 + len); ctx.stroke();
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

            for (let i = 0; i < CARDS_PER_PAGE; i++) {
                const idx = startIdx + i;
                if (idx >= allImages.length) break;
                const row = Math.floor(i / COLS);
                const col = i % COLS;
                doc.addImage(allImages[idx], 'JPEG',
                    MARGIN_X + col * CARD_W_MM,
                    MARGIN_Y + row * CARD_H_MM,
                    CARD_W_MM, CARD_H_MM);
            }

            if (settings.cutLines !== 'none') {
                drawCutLinesPDF(doc, settings, startIdx);
            }
        }

        doc.save('proxies.pdf');
    }

    function drawCutLinesPDF(doc, settings, startIdx) {
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
            for (let row = 0; row <= filledRows; row++) {
                const y = MARGIN_Y + row * CARD_H_MM;
                const cols = (row === filledRows) ? lastRowCols : filledCols;
                doc.line(MARGIN_X, y, MARGIN_X + cols * CARD_W_MM, y);
            }
            for (let col = 0; col <= filledCols; col++) {
                const x = MARGIN_X + col * CARD_W_MM;
                const rowSpan = (col <= lastRowCols) ? filledRows : (filledRows - 1);
                doc.line(x, MARGIN_Y, x, MARGIN_Y + rowSpan * CARD_H_MM);
            }
        } else if (settings.cutLines === 'corners') {
            const markLen = 4;
            for (let i = 0; i < cardsOnPage; i++) {
                const row = Math.floor(i / COLS);
                const col = i % COLS;
                const x1 = MARGIN_X + col * CARD_W_MM;
                const y1 = MARGIN_Y + row * CARD_H_MM;
                const x2 = x1 + CARD_W_MM;
                const y2 = y1 + CARD_H_MM;
                doc.line(x1 - markLen, y1, x1, y1);
                doc.line(x1, y1 - markLen, x1, y1);
                doc.line(x2, y1, x2 + markLen, y1);
                doc.line(x2, y1 - markLen, x2, y1);
                doc.line(x1 - markLen, y2, x1, y2);
                doc.line(x1, y2, x1, y2 + markLen);
                doc.line(x2, y2, x2 + markLen, y2);
                doc.line(x2, y2, x2, y2 + markLen);
            }
        }
        doc.setLineDashPattern([], 0);
    }

    // ================================================================
    //  View Management
    // ================================================================

    function showView(view) {
        currentView = view;
        // Hide all views
        dom.emptyState.style.display     = 'none';
        dom.cardListPanel.style.display  = 'none';
        dom.previewPanel.style.display   = 'none';
        dom.statsBar.style.display       = 'none';

        // Show the requested view
        switch (view) {
            case 'empty':
                dom.emptyState.style.display = 'flex';
                dom.btnGenerate.style.display = 'none';
                dom.btnBackToCards.style.display = 'none';
                dom.btnDownload.disabled = true;
                break;
            case 'cards':
                dom.cardListPanel.style.display = 'flex';
                dom.btnGenerate.style.display = '';
                dom.btnBackToCards.style.display = 'none';
                dom.btnDownload.disabled = true;
                break;
            case 'preview':
                dom.previewPanel.style.display = 'flex';
                dom.statsBar.style.display = 'flex';
                dom.btnGenerate.style.display = 'none';
                dom.btnBackToCards.style.display = '';
                break;
        }
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

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function clearAll() {
        allImages = [];
        cardSlots = [];
        pageCount = 0;
        openPopoverIdx = -1;
        dom.cardList.value = '';
        clearErrors();
        dom.btnDownload.disabled = true;
        dom.btnGenerate.disabled = false;
        showView('empty');
    }

    function onSettingsChange() {
        if (currentView === 'preview' && allImages.length) renderPreview();
    }

    // ── Init ───────────────────────────────────────────────
    function init() {
        dom = {
            cardList:           $('#cardList'),
            btnLoadCards:       $('#btnLoadCards'),
            btnGenerate:        $('#btnGenerate'),
            btnDownload:        $('#btnDownload'),
            btnClear:           $('#btnClear'),
            btnBackToCards:     $('#btnBackToCards'),
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
            cardListPanel:      $('#cardListPanel'),
            cardListView:       $('#cardListView'),
            cardListStats:      $('#cardListStats'),
            previewPanel:       $('#previewPanel'),
        };

        // Buttons
        dom.btnLoadCards.addEventListener('click', loadCards);
        dom.btnGenerate.addEventListener('click', generatePreview);
        dom.btnDownload.addEventListener('click', generatePDF);
        dom.btnClear.addEventListener('click', clearAll);
        dom.btnBackToCards.addEventListener('click', () => {
            showView('cards');
            renderCardList();
        });

        // Range label update
        dom.cutWidth.addEventListener('input', () => {
            dom.cutWidthValue.textContent = `${dom.cutWidth.value}mm`;
            onSettingsChange();
        });

        // Live preview update for settings
        ['cutLineMode', 'cutColour', 'cutStyle'].forEach(id => {
            dom[id].addEventListener('change', onSettingsChange);
        });
        dom.cutColour.addEventListener('input', onSettingsChange);

        // Start with empty view
        showView('empty');

        // Load the local card database
        loadCardDB();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
