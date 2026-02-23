#!/usr/bin/env node

/**
 * sync-cards.js
 *
 * Downloads the Scryfall "unique_artwork" bulk data, strips each card down
 * to the minimal fields needed by the MTG Proxy Builder, and writes a
 * compact JSON file to data/cards.json.
 *
 * Output format (one entry per unique artwork):
 *   { n, id, s, cn, o, d }
 *   n  = card name (string)
 *   id = scryfall card id (string, used to reconstruct image URLs)
 *   s  = set code (string)
 *   cn = collector number (string)
 *   o  = oracle_id (string, used to find variant printings)
 *   d  = 1 if double-faced (images on card_faces), omitted otherwise
 *
 * Image URLs are reconstructed client-side:
 *   https://cards.scryfall.io/{quality}/{face}/{id[0]}/{id[1]}/{id}.{ext}
 *
 * Usage:  node scripts/sync-cards.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BULK_DATA_URL = 'https://api.scryfall.com/bulk-data';
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'cards.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

// ── Layouts where image_uris live on card_faces instead of root ──
const DFC_LAYOUTS = new Set([
    'transform',
    'modal_dfc',
    'reversible_card',
    'art_series',
    'double_faced_token',
]);

// ── HTTP helper (follows redirects, supports https and http) ──
function httpGet(url, options = {}) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            headers: {
                'User-Agent': 'MTGProxyBuilder/1.0 (GitHub Action sync)',
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate',
                ...options.headers,
            },
        }, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(httpGet(res.headers.location, options));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }

            // Decompress if gzipped
            let stream = res;
            const encoding = res.headers['content-encoding'];
            if (encoding === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
                stream = res.pipe(zlib.createInflate());
            }

            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
        });
        req.on('error', reject);
    });
}

// ── Stream-parse large JSON array without loading it all into memory ──
// The bulk data is a JSON array of objects. We use a simple streaming
// approach: read chunks, find complete top-level objects via brace counting.
function streamParseJsonArray(buffer, onObject) {
    const text = buffer.toString('utf8');
    let depth = 0;
    let inString = false;
    let escape = false;
    let objStart = -1;
    let count = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (escape) {
            escape = false;
            continue;
        }

        if (ch === '\\' && inString) {
            escape = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') {
            if (depth === 0) objStart = i;
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && objStart !== -1) {
                const objStr = text.substring(objStart, i + 1);
                try {
                    const obj = JSON.parse(objStr);
                    onObject(obj);
                    count++;
                } catch (e) {
                    // Skip malformed objects
                    console.warn(`  Warning: skipped malformed object at position ${objStart}`);
                }
                objStart = -1;
            }
        }
    }

    return count;
}

// ── Extract minimal card data ──
function extractCard(card) {
    // Skip cards without any image data
    const isDFC = DFC_LAYOUTS.has(card.layout);
    const hasImages = isDFC
        ? (card.card_faces && card.card_faces.some(f => f.image_uris))
        : !!card.image_uris;

    if (!hasImages) return null;

    const entry = {
        n: card.name,
        id: card.id,
        s: card.set,
        cn: card.collector_number,
        o: card.oracle_id,
    };

    if (isDFC) {
        entry.d = 1;
    }

    return entry;
}

// ── Main ──
async function main() {
    console.log('Fetching bulk data manifest…');
    const manifestBuf = await httpGet(BULK_DATA_URL);
    const manifest = JSON.parse(manifestBuf.toString('utf8'));

    // Find the unique_artwork entry
    const bulkEntry = manifest.data.find(d => d.type === 'unique_artwork');
    if (!bulkEntry) {
        throw new Error('Could not find "unique_artwork" in bulk data manifest');
    }

    console.log(`Found unique_artwork (updated ${bulkEntry.updated_at})`);
    console.log(`  Size: ${(bulkEntry.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  Downloading from: ${bulkEntry.download_uri}`);
    console.log('  This may take a few minutes…');

    const dataBuf = await httpGet(bulkEntry.download_uri);
    console.log(`  Downloaded ${(dataBuf.length / 1024 / 1024).toFixed(1)} MB (decompressed)`);

    console.log('Parsing and extracting card data…');
    const cards = [];
    const totalParsed = streamParseJsonArray(dataBuf, (card) => {
        const entry = extractCard(card);
        if (entry) cards.push(entry);
    });

    console.log(`  Parsed ${totalParsed} cards, kept ${cards.length} with images`);

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Write cards.json (minified — no pretty-printing to save space)
    const json = JSON.stringify(cards);
    fs.writeFileSync(OUTPUT_FILE, json, 'utf8');
    const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
    console.log(`  Wrote ${OUTPUT_FILE} (${sizeMB} MB, ${cards.length} entries)`);

    // Write meta.json
    const meta = {
        updated: new Date().toISOString(),
        source: 'unique_artwork',
        sourceUpdated: bulkEntry.updated_at,
        count: cards.length,
    };
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
    console.log(`  Wrote ${META_FILE}`);

    console.log('Done!');
}

main().catch(err => {
    console.error('Sync failed:', err.message);
    process.exit(1);
});
