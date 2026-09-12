// ==UserScript==
// @name         Manga Plus,Bookwalker,Manga-UP,Manga Million,Gangan Online & Zebcrack Ripper
// @namespace    https://greasyfork.org/en/users/1553223-ozler365
// @version      8.7
// @description  Download Chapters From Manga Plus,Bookwalker,Manga-UP,Manga Million,Gangan Online & Zebcrack
// @match        https://mangamillion.shueisha.co.jp/*
// @match        https://global.manga-up.com/*
// @match        https://www.ganganonline.com/*
// @match        https://zebrack-comic.shueisha.co.jp/*
// @match        https://mangaplus.shueisha.co.jp/*
// @match        https://bookwalker.com/*
// @author       ozler365
// @license      MIT
// @icon         https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://mangaplus.shueisha.co.jp&size=32
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_download
// @contributionURL https://www.buymeacoffee.com/ozler
// @downloadURL https://update.greasyfork.org/scripts/594343/Manga%20Plus%2CBookwalker%2CManga-UP%2CManga%20Million%2CGangan%20Online%20%20Zebcrack%20Ripper.user.js
// @updateURL https://update.greasyfork.org/scripts/594343/Manga%20Plus%2CBookwalker%2CManga-UP%2CManga%20Million%2CGangan%20Online%20%20Zebcrack%20Ripper.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // --- Core State & Globals ---
    const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const STORAGE_KEY_AUTO_DL = 'mm_auto_download_enabled';
    
    const state = {
        urlToBlob: new Map(),
        pageRegistry: new Map(),
        isAutoScrolling: false,
        isDownloading: false,
        autoDownload: localStorage.getItem(STORAGE_KEY_AUTO_DL) !== 'false',
        currentHref: window.location.href,
        currentMangaUpTitle: null,
        forceDownload: false,
        cachedProgressEl: null, 
        cachedFolderName: null,
        lastProgressScan: 0 
    };

    let syncTimeout = null;

    // --- 0. UI Status Helper ---
    function setStatus(msg, isError = false) {
        const statusEl = document.getElementById('mm-status');
        if (!statusEl) return;
        if (!msg) {
            statusEl.style.display = 'none';
            return;
        }
        statusEl.style.display = 'block';
        statusEl.style.color = isError ? '#ff4c4c' : '#00e676';
        statusEl.innerText = msg;
    }

    // --- 0. Smart Folder Naming ---
    function getFolderName() {
        if (state.cachedFolderName) return state.cachedFolderName;

        let name = document.title.replace(/[<>:"/\\|?*]/g, "").trim();
        
        if (window.location.hostname.includes("manga-up.com")) {
            let chapText = "";
            const candidates = document.querySelectorAll('p, div, span, h1, h2');
            
            for (let i = 0; i < candidates.length; i++) {
                const txt = candidates[i].innerText ? candidates[i].innerText.trim() : "";
                if (/^(Chapter|Ep)\s*[\d.-]+/i.test(txt) && txt.length < 50) {
                    const rect = candidates[i].getBoundingClientRect();
                    if (rect.top >= 0 && rect.top < 150) { 
                        chapText = txt;
                        break;
                    }
                }
            }
            const urlId = window.location.pathname.split('/').filter(Boolean).pop() || "Chap";
            name = chapText ? `MangaUP - ${chapText} (${urlId})` : `MangaUP - ${urlId}`;
        }
        
        state.cachedFolderName = name.replace(/[<>:"/\\|?*]/g, "").trim() || "Manga_Chapter";
        return state.cachedFolderName;
    }

    // --- 0. SPA Navigation Reset ---
    function resetState() {
        state.urlToBlob.clear();
        state.pageRegistry.clear();
        state.isAutoScrolling = false;
        state.isDownloading = false;
        state.forceDownload = false;
        state.cachedProgressEl = null;
        state.cachedFolderName = null;
        state.lastProgressScan = 0;
        state.currentMangaUpTitle = null;
        
        const mainBtn = document.getElementById('mm-main-btn');
        if (mainBtn) {
            mainBtn.innerText = "Start Auto-Capture";
            mainBtn.style.background = "#e60012";
            mainBtn.disabled = false;
        }
        
        const totalInput = document.getElementById('mm-total');
        if (totalInput) {
            totalInput.value = "";
            delete totalInput.dataset.manual;
        }
        
        setStatus('');
        updateUI();
    }

    // --- 1. Detect Native Image Format ---
    async function detectExtension(blob) {
        if (blob.type && blob.type.startsWith('image/')) {
            const t = blob.type.split('/')[1].toLowerCase();
            if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(t)) {
                return t === 'jpeg' ? 'jpg' : t;
            }
        }
        try {
            const buffer = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
            if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
            if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
            if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'webp';
            const ftyp = String.fromCharCode(...buffer.slice(4, 12));
            if (ftyp.includes('ftyp') || ftyp.includes('avif')) return 'avif';
        } catch (e) {}
        return 'jpg';
    }

    // --- 2. Lossless Format Converter (AVIF -> PNG) ---
    async function convertToPNG(blob) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const tempUrl = URL.createObjectURL(blob);
            
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                
                canvas.toBlob((newBlob) => {
                    URL.revokeObjectURL(tempUrl);
                    if (newBlob) resolve(newBlob);
                    else reject(new Error("Canvas conversion failed"));
                }, 'image/png');
            };
            
            img.onerror = () => {
                URL.revokeObjectURL(tempUrl);
                reject(new Error("Image failed to load"));
            };
            
            img.src = tempUrl;
        });
    }

    // --- 3. The Hook (Shielded Primary Capture - Placeholder Filter) ---
    const originalCreateObjectURL = targetWindow.URL.createObjectURL;

    targetWindow.URL.createObjectURL = function(blob) {
        const url = originalCreateObjectURL.apply(this, arguments);
        
        if (state.isDownloading) return url;
        
        try {
            if (blob instanceof Blob && blob.size > 1024) {
                state.urlToBlob.set(url, blob);
                triggerSync(); 
            }
        } catch (e) {}
        return url;
    };

    // --- 4. Match Blobs to Real Page Numbers (UPGRADED EXTRACTOR) ---
    function extractPageNumber(img, fallbackIndex) {
        const attributes = [img.getAttribute('alt'), img.className, img.id].filter(Boolean).join(' ');
        const prefixMatch = attributes.match(/(?:page|content-p|p)[_-\s]*(\d+)/i);
        if (prefixMatch) return parseInt(prefixMatch[1], 10);
        const standaloneMatch = attributes.match(/\b(\d{2,4})\b/);
        if (standaloneMatch) return parseInt(standaloneMatch[1], 10);
        return fallbackIndex;
    }

    function triggerSync() {
        if (syncTimeout) clearTimeout(syncTimeout);
        syncTimeout = setTimeout(syncPagesWithDOM, 100);
    }

    function syncPagesWithDOM() {
        if (state.isDownloading) return;
        
        const images = document.querySelectorAll('img[src^="blob:"]');
        let needsUIUpdate = false;

        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (state.urlToBlob.has(img.src)) {
                const pageNum = extractPageNumber(img, i + 1);
                if (!state.pageRegistry.has(pageNum)) {
                    state.pageRegistry.set(pageNum, state.urlToBlob.get(img.src));
                    needsUIUpdate = true;
                }
            }
        }
        if (needsUIUpdate) updateUI();
    }

    // --- 5. Auto-detect Total Pages ---
    function getProgress() {
        const regex = /^(\d+)\s*\/\s*(\d+)$/;
        
        if (state.cachedProgressEl && state.cachedProgressEl.offsetParent !== null) {
            const match = state.cachedProgressEl.innerText.trim().match(regex);
            if (match) return { current: parseInt(match[1], 10), total: parseInt(match[2], 10) };
        }

        const now = Date.now();
        if (now - state.lastProgressScan < 2000) return null;
        state.lastProgressScan = now;

        const allDivs = document.querySelectorAll('div, span, p');
        for (let i = 0; i < allDivs.length; i++) {
            const el = allDivs[i];
            if (el.offsetParent === null) continue;
            const match = el.innerText.trim().match(regex);
            if (match) {
                state.cachedProgressEl = el; 
                return { current: parseInt(match[1], 10), total: parseInt(match[2], 10) };
            }
        }
        return null;
    }

    // --- 6. SMART Auto-Scroll Logic ---
    async function smartAutoScroll() {
        state.isAutoScrolling = true;
        const mainBtn = document.getElementById('mm-main-btn');
        mainBtn.innerText = "Stop Auto-Capture";
        mainBtn.style.background = "#f0ad4e";

        let progress = getProgress();
        const isMangaUp = window.location.hostname.includes("manga-up.com");
        const isZebrack = window.location.hostname.includes("zebrack-comic.shueisha.co.jp");
        const isMangaMillion = window.location.hostname.includes("mangamillion.shueisha.co.jp");
        const isGangan = window.location.hostname.includes("ganganonline.com");
        const isSlideSite = isMangaUp || isZebrack || isMangaMillion;
        
        // AUTO-REWIND (UPGRADED)
        const needsRewind = (progress && progress.current > 1) || isGangan || isMangaMillion || (isMangaUp && window.scrollY > 100);
        
        if (needsRewind) {
            setStatus('Rewinding to first page...', false);
            
            if (isMangaUp || isGangan || isMangaMillion) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', code: 'Home', keyCode: 36, which: 36, bubbles: true }));
                await new Promise(r => setTimeout(r, 500));
            }
            
            let rewindGuard = 0;
            progress = getProgress();
            while (progress && progress.current > 1 && rewindGuard < 300 && state.isAutoScrolling) {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true }));
                await new Promise(r => setTimeout(r, 40)); 
                progress = getProgress();
                rewindGuard++;
            }
            await new Promise(r => setTimeout(r, 800)); 
            setStatus('');
        }

        while (state.isAutoScrolling) {
            const speed = parseInt(document.getElementById('mm-speed').value, 10);
            progress = getProgress();
            let newlyLoaded = false;
            
            let visiblePlaceholders = [];
            if (isSlideSite) {
                visiblePlaceholders = Array.from(document.querySelectorAll('[data-testid="placeholder"]')).filter(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.right > -50 && rect.left < (window.innerWidth + 50) && rect.width > 50;
                });
            }

            if (isSlideSite && visiblePlaceholders.length > 0) {
                for (const placeholder of visiblePlaceholders) {
                    let waitAttempts = 0;
                    while (waitAttempts < 300) { 
                        if (!state.isAutoScrolling) return;

                        const img = placeholder.querySelector('img');
                        
                        if (img) {
                            const src = img.getAttribute('src') || '';
                            if (src.startsWith('blob:') && img.complete && img.naturalWidth > 100) {
                                if (!img.dataset.scrollProcessed) {
                                    img.dataset.scrollProcessed = "true";
                                    newlyLoaded = true;
                                }
                                break; 
                            }
                        }
                        await new Promise(r => setTimeout(r, speed));
                        waitAttempts++;
                    }
                }
            } else if (isGangan) {
                const visibleImgs = Array.from(document.querySelectorAll('img')).filter(el => {
                    if (!el.parentElement) return false;
                    const parentRect = el.parentElement.getBoundingClientRect();
                    return parentRect.right > -300 && parentRect.left < (window.innerWidth + 300) && parentRect.width > 50;
                });

                for (const img of visibleImgs) {
                    let waitAttempts = 0;
                    while (waitAttempts < 300) {
                        if (!state.isAutoScrolling) return;
                        if (img.dataset.scrollProcessed === "true") break;

                        const src = img.getAttribute('src') || '';
                        if (src.startsWith('blob:') && img.complete && img.naturalWidth > 100) {
                            img.dataset.scrollProcessed = "true";
                            newlyLoaded = true;
                            break; 
                        }
                        
                        await new Promise(r => setTimeout(r, speed));
                        waitAttempts++;
                    }
                }
            } else {
                const visibleImgs = Array.from(document.querySelectorAll('img')).filter(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.right > -300 && rect.left < (window.innerWidth + 300) && rect.width > 50;
                });

                for (const img of visibleImgs) {
                    let waitAttempts = 0;
                    while (waitAttempts < 300) {
                        if (!state.isAutoScrolling) return;
                        if (img.dataset.scrollProcessed === "true") break;

                        const src = img.getAttribute('src') || '';
                        if (src.startsWith('blob:') && img.complete && img.naturalWidth > 100) {
                            img.dataset.scrollProcessed = "true";
                            newlyLoaded = true;
                            break; 
                        }
                        
                        await new Promise(r => setTimeout(r, speed));
                        waitAttempts++;
                    }
                }
            }

            if (newlyLoaded) {
                await new Promise(r => setTimeout(r, 150)); 
            }

            // Execute Native RTL Scroll
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, which: 37, bubbles: true }));
            
            await new Promise(r => setTimeout(r, 50));

            syncPagesWithDOM();
            progress = getProgress() || progress;

            if (progress && progress.current >= progress.total) {
                state.isAutoScrolling = false;
                break; 
            }
        }
        
        if (!state.isAutoScrolling) {
            syncPagesWithDOM();
            
            if (state.autoDownload) {
                mainBtn.innerText = "Auto-Downloading...";
                mainBtn.style.background = "#2563eb";
                downloadToFolder();
            } else {
                mainBtn.innerText = "Download Folder";
                mainBtn.style.background = "#2563eb";
                setStatus('All panels captured! Click to download.', false);
            }
        }
    }

    // --- 7. Manga-UP Canvas Fallback Method ---
    async function captureMissedImagesMangaUp() {
        if (!window.location.hostname.includes("manga-up.com")) return;
        
        const images = document.querySelectorAll('img[src^="blob:"]');
        let missedCount = 0;
        
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (!state.urlToBlob.has(img.src) && img.complete && img.naturalWidth > 100) {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    
                    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95));
                    if (blob && blob.size > 1024) {
                        state.urlToBlob.set(img.src, blob);
                        missedCount++;
                    }
                } catch (e) {}
            }
        }
        if (missedCount > 0) syncPagesWithDOM();
    }

    // --- 8. Direct Folder Download with Conversion ---
    async function downloadToFolder() {
        if (state.isDownloading) return;
        
        const btn = document.getElementById('mm-main-btn');
        state.isDownloading = true; 
        
        if (window.location.hostname.includes("manga-up.com")) {
            setStatus('Checking for missed images...', false);
            btn.disabled = true;
            await captureMissedImagesMangaUp();
        }
        
        syncPagesWithDOM();

        if (state.pageRegistry.size === 0) {
            setStatus('No pages captured yet! Scroll first.', true);
            state.isDownloading = false;
            btn.innerText = "Start Auto-Capture";
            btn.style.background = "#e60012";
            btn.disabled = false;
            return;
        }

        const totalInput = document.getElementById('mm-total').value;
        const expectedTotal = parseInt(totalInput.replace(/\D/g, ''), 10);
        
        if (expectedTotal && state.pageRegistry.size < expectedTotal && !state.forceDownload) {
            setStatus(`Missing pages (${state.pageRegistry.size}/${expectedTotal}). Refresh, or click Download again to force save.`, true);
            state.forceDownload = true;
            state.isDownloading = false;
            btn.innerText = "Force Download";
            btn.disabled = false;
            return;
        }

        state.forceDownload = false; 
        setStatus('Processing download concurrently...', false);
        btn.innerText = "Converting and Saving..."; 
        btn.disabled = true;
        const cleanTitle = getFolderName();

        const sortedPages = Array.from(state.pageRegistry.entries()).sort((a, b) => a[0] - b[0]);
        const pad = Math.max(String(sortedPages[sortedPages.length - 1][0]).length, 3);

        const downloadPromises = sortedPages.map(async ([pageNum, originalBlob]) => {
            let finalBlob = originalBlob;
            let ext = await detectExtension(finalBlob);

            if (ext === 'avif' || ext === 'webp') {
                try {
                    finalBlob = await convertToPNG(originalBlob);
                    ext = 'png';
                } catch (e) {}
            }

            const filename = `Page_${String(pageNum).padStart(pad, '0')}.${ext}`;
            const fullPath = `${cleanTitle}/${filename}`;

            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = function() {
                    GM_download({
                        url: reader.result,
                        name: fullPath,
                        saveAs: false,
                        onload: resolve,
                        onerror: (err) => {
                            console.error(`Error saving ${filename}:`, err);
                            resolve(); 
                        }
                    });
                };
                reader.readAsDataURL(finalBlob);
            });
        });

        await Promise.all(downloadPromises);

        btn.innerText = "Done!";
        setStatus('Download initiated successfully!', false);
        setTimeout(() => { 
            btn.innerText = "Start Auto-Capture"; 
            btn.style.background = "#e60012";
            btn.disabled = false; 
            state.isDownloading = false; 
            setStatus('');
        }, 3000);
    }
    
    function handleMainButtonClick() {
        if (state.isDownloading) return;

        if (state.isAutoScrolling) {
            state.isAutoScrolling = false;
            const mainBtn = document.getElementById('mm-main-btn');
            mainBtn.innerText = "Start Auto-Capture";
            mainBtn.style.background = "#e60012";
            return;
        }

        const mainBtn = document.getElementById('mm-main-btn');
        if (mainBtn.innerText === "Download Folder" || mainBtn.innerText === "Force Download") {
            downloadToFolder();
        } else {
            smartAutoScroll();
        }
    }

    // --- 9. UI Construction & Updates ---
    function updateUI() {
        const count = document.getElementById('mm-count');
        if (count) count.innerText = state.pageRegistry.size;
    }

    setInterval(() => {
        let triggerReset = false;
        
        if (window.location.href !== state.currentHref) {
            state.currentHref = window.location.href;
            triggerReset = true;
        }

        // --- NEW: MangaUP Infinite Scroll Chapter Change Detection ---
        if (window.location.hostname.includes("manga-up.com")) {
            const h1 = document.querySelector('h1[class^="Header_title"]');
            if (h1 && h1.innerText) {
                const currentTitle = h1.innerText.trim();
                if (state.currentMangaUpTitle !== null && state.currentMangaUpTitle !== currentTitle) {
                    triggerReset = true;
                }
                state.currentMangaUpTitle = currentTitle;
            }
        }
        
        if (triggerReset) {
            resetState();
            // Recapture the title immediately after reset so it isn't left empty
            if (window.location.hostname.includes("manga-up.com")) {
                const h1 = document.querySelector('h1[class^="Header_title"]');
                if (h1) state.currentMangaUpTitle = h1.innerText.trim();
            }
        }
        
        syncPagesWithDOM();

        const progress = getProgress();
        const totalInput = document.getElementById('mm-total');
        if (progress && totalInput && !totalInput.dataset.manual) {
            totalInput.value = `/ ${progress.total}`;
        }
    }, 400);

    window.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = `
            #mm-modal {
                position: fixed;
                top: 15%;
                right: 20px;
                z-index: 999999;
                background: #141416;
                color: #ffffff;
                padding: 14px;
                border-radius: 12px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                box-shadow: 0 10px 30px rgba(0,0,0,0.7), 0 0 1px rgba(255,255,255,0.2);
                width: 230px;
                border: 1px solid #27272a;
                user-select: none;
            }
            #mm-header {
                cursor: grab;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding-bottom: 10px;
                border-bottom: 1px solid #27272a;
                margin-bottom: 12px;
            }
            #mm-header:active {
                cursor: grabbing;
            }
            .mm-title {
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.8px;
                color: #e4e4e7;
            }
            .mm-min-btn {
                background: transparent;
                border: none;
                color: #a1a1aa;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                padding: 0 4px;
            }
            .mm-min-btn:hover {
                color: #ffffff;
            }
            #mm-speed {
                -webkit-appearance: none !important;
                appearance: none !important;
                accent-color: #e60012 !important;
                width: 100% !important;
                background: transparent !important;
                margin: 6px 0 !important;
                cursor: pointer !important;
            }
            #mm-speed::-webkit-slider-runnable-track {
                width: 100% !important;
                height: 5px !important;
                background: #e60012 !important;
                border-radius: 3px !important;
            }
            #mm-speed::-webkit-slider-thumb {
                -webkit-appearance: none !important;
                height: 15px !important;
                width: 15px !important;
                border-radius: 50% !important;
                background: #ffffff !important;
                margin-top: -5px !important;
                box-shadow: 0 0 4px rgba(0,0,0,0.6) !important;
            }
            #mm-speed::-moz-range-track {
                width: 100% !important;
                height: 5px !important;
                background: #e60012 !important;
                border-radius: 3px !important;
            }
            #mm-speed::-moz-range-thumb {
                height: 15px !important;
                width: 15px !important;
                border: none !important;
                border-radius: 50% !important;
                background: #ffffff !important;
            }
            .mm-toggle-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 12px;
                font-size: 11px;
                color: #d4d4d8;
            }
            .mm-switch {
                position: relative;
                display: inline-block;
                width: 32px;
                height: 18px;
            }
            .mm-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            .mm-slider {
                position: absolute;
                cursor: pointer;
                top: 0; left: 0; right: 0; bottom: 0;
                background-color: #3f3f46;
                transition: .2s;
                border-radius: 18px;
            }
            .mm-slider:before {
                position: absolute;
                content: "";
                height: 12px;
                width: 12px;
                left: 3px;
                bottom: 3px;
                background-color: white;
                transition: .2s;
                border-radius: 50%;
            }
            input:checked + .mm-slider {
                background-color: #00e676;
            }
            input:checked + .mm-slider:before {
                transform: translateX(14px);
            }
            .mm-support-link {
                color: #f0ad4e;
                text-decoration: none;
                font-size: 10px;
                display: block;
                margin-top: 8px;
                text-align: center;
            }
            .mm-support-link:hover {
                color: #ffffff;
            }
        `;
        document.head.appendChild(style);

        const ui = document.createElement('div');
        ui.id = 'mm-modal';
        ui.innerHTML = `
            <div id="mm-header">
                <span class="mm-title">MANGA RIPPER</span>
                <button class="mm-min-btn" id="mm-toggle-min">−</button>
            </div>
            
            <div id="mm-body">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; background: #202024; padding: 8px 10px; border-radius: 6px;">
                    <span style="font-size: 13px; font-weight: 600; color: #00e676;">Captured: <span id="mm-count">0</span></span>
                    <input type="text" id="mm-total" placeholder="/ Total" style="width: 50px; background: transparent; border: none; color: #71717a; text-align: right; font-size: 12px; font-weight: 600;" title="Auto-detects, or manually input">
                </div>

                <div style="margin-bottom: 10px;">
                    <label style="font-size: 10px; color: #a1a1aa; display: block; margin-bottom: 3px;" id="mm-speed-lbl">Scroll Delay: 50ms</label>
                    <input type="range" id="mm-speed" min="50" max="2500" step="50" value="50">
                </div>

                <div class="mm-toggle-row">
                    <span>Auto-Download</span>
                    <label class="mm-switch">
                        <input type="checkbox" id="mm-auto-dl-toggle" ${state.autoDownload ? 'checked' : ''}>
                        <span class="mm-slider"></span>
                    </label>
                </div>

                <div id="mm-status" style="font-size: 11px; font-weight: 600; margin-bottom: 8px; text-align: center; display: none; line-height: 1.2;"></div>

                <button id="mm-main-btn" style="width: 100%; padding: 10px; background: #e60012; color: white; border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; transition: background 0.2s; margin-bottom: 8px;">Start Auto-Capture</button>
                <button id="mm-dedicated-dl-btn" style="width: 100%; padding: 10px; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; transition: background 0.2s;">Download Captured</button>
                <a href="https://www.buymeacoffee.com/ozler" target="_blank" class="mm-support-link">☕ Support the Developer</a>
            </div>
        `;
        
        document.body.appendChild(ui);

        const bodyEl = document.getElementById('mm-body');
        const minBtn = document.getElementById('mm-toggle-min');
        let isMinimized = false;
        minBtn.onclick = () => {
            isMinimized = !isMinimized;
            bodyEl.style.display = isMinimized ? 'none' : 'block';
            minBtn.innerText = isMinimized ? '+' : '−';
            ui.style.width = isMinimized ? '130px' : '230px';
        };

        const headerEl = document.getElementById('mm-header');
        let isDragging = false, startX, startY, initLeft, initTop;

        headerEl.addEventListener('mousedown', (e) => {
            if (e.target === minBtn) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = ui.getBoundingClientRect();
            initLeft = rect.left;
            initTop = rect.top;
            ui.style.right = 'auto';
            ui.style.left = `${initLeft}px`;
            ui.style.top = `${initTop}px`;
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            ui.style.left = `${initLeft + (e.clientX - startX)}px`;
            ui.style.top = `${initTop + (e.clientY - startY)}px`;
        });

        window.addEventListener('mouseup', () => { isDragging = false; });

        document.getElementById('mm-main-btn').onclick = handleMainButtonClick;
        document.getElementById('mm-dedicated-dl-btn').onclick = downloadToFolder;

        const toggleAuto = document.getElementById('mm-auto-dl-toggle');
        toggleAuto.onchange = (e) => {
            state.autoDownload = e.target.checked;
            localStorage.setItem(STORAGE_KEY_AUTO_DL, String(state.autoDownload));
        };
        
        const totalInput = document.getElementById('mm-total');
        totalInput.oninput = () => { totalInput.dataset.manual = "true"; };

        const speedSlider = document.getElementById('mm-speed');
        const speedLbl = document.getElementById('mm-speed-lbl');
        speedSlider.oninput = (e) => {
            speedLbl.innerText = `Scroll Delay: ${e.target.value}ms`;
        };
    });
})();