console.log("[AndacCatcher] Background service worker başladı.");

// ------------------------------------

// MEDIA STORAGE

// ------------------------------------

const mediaByTab = new Map();

const activeDownloads = new Map();

// v1.1: Kalici indirme gecmisi. Native portlar bellekte kalir,
// kayitlar ise chrome.storage.local uzerinden yeniden yuklenir.
const downloadStates = new Map();
const STORAGE_KEY = "vcDownloadHistoryV11";
const FINISHED = new Set(["completed", "cancelled", "error", "interrupted"]);
let persistTimer = null;
let persistQueue = Promise.resolve();

function historySnapshot() {
    return [...downloadStates.values()]
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 50);
}

function persistNow() {
    if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    const snapshot = historySnapshot();
    // Yazmalari siraya koy: eski bir yazma yenisini ezmesin.
    persistQueue = persistQueue.catch(() => {}).then(() =>
        chrome.storage.local.set({ [STORAGE_KEY]: snapshot })
    );
    return persistQueue.catch(error => {
        console.error("[AndacCatcher] Gecmis kaydedilemedi:", error);
    });
}

function schedulePersist(immediate = false) {
    if (immediate) return persistNow();
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistTimer = null;
        void persistNow();
    }, 500);
}

const storageReady = (async () => {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        const stored = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
        let modified = false;
        for (const item of stored) {
            if (!item || typeof item.id !== "string") continue;
            // Bu service worker acildiginda native portlar geri getirilemez.
            // O yuzden onceki oturumdan kalan aktif kayitlar kesintiye ugradi.
            const restored = { ...item };
            if (!FINISHED.has(restored.status)) {
                restored.status = "interrupted";
                restored.message = "Tarayici veya arka plan baglantisi yeniden baslatildi.";
                restored.updatedAt = Date.now();
                modified = true;
            }
            if (!downloadStates.has(restored.id)) downloadStates.set(restored.id, restored);
        }
        if (modified) await persistNow();
    } catch (error) {
        console.error("[AndacCatcher] Gecmis yuklenemedi:", error);
    }
})();

function updateDownloadState(id, changes) {
    const previous = downloadStates.get(id) || { id };
    const next = { ...previous, ...changes, id, updatedAt: Date.now() };
    downloadStates.set(id, next);
    if (downloadStates.size > 50) {
        const keep = new Set(historySnapshot().map(item => item.id));
        for (const key of downloadStates.keys()) {
            if (!keep.has(key) && !activeDownloads.has(key)) downloadStates.delete(key);
        }
    }
    schedulePersist(FINISHED.has(next.status));
    chrome.runtime.sendMessage({ type: "VC_DOWNLOAD_UPDATED", download: next })
        .catch(() => {});
}

function getTabMedia(tabId) {

    if (!mediaByTab.has(tabId)) {

        mediaByTab.set(tabId, new Map());

    }

    return mediaByTab.get(tabId);

}

function detectType(url, contentType = "") {

    const cleanUrl = url.toLowerCase();

    const ct = contentType.toLowerCase();

    if (

        cleanUrl.includes(".m3u8") ||

        ct.includes("application/vnd.apple.mpegurl") ||

        ct.includes("application/x-mpegurl")

    ) {

        return "HLS";

    }

    if (

        cleanUrl.includes(".mpd") ||

        ct.includes("application/dash+xml")

    ) {

        return "DASH";

    }

    if (

        cleanUrl.includes(".mp4") ||

        ct.includes("video/mp4")

    ) {

        return "MP4";

    }

    if (

        cleanUrl.includes(".webm") ||

        ct.includes("video/webm")

    ) {

        return "WEBM";

    }

    if (

        cleanUrl.includes(".m4s") ||

        ct.includes("video/iso.segment")

    ) {

        return "M4S";

    }

    if (/\.ts(?:\?|$)/i.test(url)) {

        return "TS";

    }

    if (ct.startsWith("video/")) {

        return "VIDEO";

    }

    if (ct.startsWith("audio/")) {

        return "AUDIO";

    }

    return "MEDIA";

}

function saveMedia(tabId, media) {

    if (

        typeof tabId !== "number" ||

        tabId < 0 ||

        !media?.url

    ) {

        return;

    }

    const tabMedia = getTabMedia(tabId);

    if (tabMedia.has(media.url)) {

        return;

    }

    const type = media.type || detectType(

        media.url,

        media.contentType || ""

    );

    const item = {

        url: media.url,

        type,

        contentType: media.contentType || "",

        requestType: media.requestType || "",

        isSegment: type === "TS" || type === "M4S",

        detectedAt: Date.now()

    };

    tabMedia.set(media.url, item);

    console.log(

        "[AndacCatcher] MEDIA:",

        tabId,

        item.type,

        item.url

    );

}

// ------------------------------------

// NETWORK MEDIA DETECTOR

// ------------------------------------

chrome.webRequest.onHeadersReceived.addListener(

    details => {

        const headers = details.responseHeaders || [];

        const contentTypeHeader = headers.find(

            header =>

                header.name?.toLowerCase() === "content-type"

        );

        const contentType = contentTypeHeader?.value || "";

        const normalizedContentType = contentType.toLowerCase();

        const interesting =

            details.type === "media" ||

            normalizedContentType.startsWith("video/") ||

            normalizedContentType.startsWith("audio/") ||

            normalizedContentType.includes("mpegurl") ||

            normalizedContentType.includes("dash+xml") ||

            /\.(mp4|webm|m3u8|mpd|m4s|ts)(?:\?|$)/i.test(

                details.url

            );

        if (!interesting) {

            return;

        }

        saveMedia(details.tabId, {

            url: details.url,

            type: detectType(details.url, contentType),

            contentType,

            requestType: details.type

        });

    },

    {

        urls: ["\<all_urls>"]

    },

    ["responseHeaders"]

);

// ------------------------------------

// CONTENT SCRIPT MESSAGES

// ------------------------------------

chrome.runtime.onMessage.addListener(

    (message, sender, sendResponse) => {

        console.log(

            "[AndacCatcher] MESSAGE:",

            message,

            sender.tab?.id,

            sender.frameId

        );

        const tabId = sender.tab?.id;

        if (message.type === "PING") {

            sendResponse({

                ok: true,

                tabId,

                frameId: sender.frameId

            });

            return;

        }

        if (message.type === "GET_HLS") {

            if (typeof tabId !== "number") {

                sendResponse([]);

                return;

            }

            // v1.5.4: Yalnizca tek-video sayfalarinda agdan yakalanan
            // HLS manifestlerini fallback olarak sun. Coklu videoda
            // baska videonun kaynagini sessizce kullanma.
            const requestedUrls = Array.isArray(message.urls)
                ? message.urls.filter(url => typeof url === "string" && /^https?:\/\//i.test(url))
                : [];
            const allowed = new Set(requestedUrls);
            const allowNetworkFallback = message.singleVideo === true;
            const hlsSources = Array.from(getTabMedia(tabId).values())
                .filter(item => item.type === "HLS" &&
                    (allowed.has(item.url) || allowNetworkFallback))
                .sort((a, b) => a.detectedAt - b.detectedAt);

            console.log(

                "[AndacCatcher] HLS kaynakları:",

                hlsSources

            );

            sendResponse(hlsSources);

            return;

        }

        if (message.type === "DOM_MEDIA_FOUND") {

            if (typeof tabId === "number") {

                saveMedia(tabId, {

                    url: message.url,

                    type: detectType(message.url),

                    requestType: "dom"

                });

            }

            sendResponse({ ok: true });

            return;

        }

        if (message.type === "GET_MEDIA") {

            if (typeof tabId !== "number") {

                sendResponse([]);

                return;

            }

            sendResponse(

                Array.from(getTabMedia(tabId).values())

            );

            return;

        }

        if (message.type === "DOWNLOAD_DIRECT") {

            const url = message.url;

            if (

                typeof url !== "string" ||

                !/^https?:\/\//i.test(url)

            ) {

                sendResponse({

                    ok: false,

                    error: "Geçersiz video URL'si."

                });

                return;

            }

            chrome.downloads.download({

                url,

                saveAs: true

            })

            .then(downloadId => {

                console.log(

                    "[AndacCatcher] İndirme başladı:",

                    downloadId,

                    url

                );

                sendResponse({

                    ok: true,

                    downloadId

                });

            })

            .catch(error => {

                console.error(

                    "[AndacCatcher] İndirme hatası:",

                    error

                );

                sendResponse({

                    ok: false,

                    error: error.message

                });

            });

            return true;

        }

    }

);

// ------------------------------------
// v1.3 - EN FAZLA 3 ESZAMANLI HLS + FIFO KUYRUK
// ------------------------------------
// v1.4.1: Kullanici tarafindan secilebilen eszamanli HLS limiti.
const SETTINGS_KEY = "vcMaxConcurrentHlsV141";
let maxConcurrentHls = 3;
const settingsReady = chrome.storage.local.get(SETTINGS_KEY).then(data => {
    const value = Number(data[SETTINGS_KEY]);
    if ([1, 2, 3].includes(value)) maxConcurrentHls = value;
}).catch(error => console.error("Ayarlar yuklenemedi:", error));
const waitingDownloads = [];
const jobs = new Map();
const runningIds = new Set();

function notifyContent(job, payload) {
    chrome.tabs.sendMessage(job.tabId, {
        type: "DOWNLOAD_PROGRESS", downloadId: job.id, ...payload
    }, { frameId: job.frameId }).catch(() => {});
}

function queuePositions() {
    waitingDownloads.forEach((id, index) => {
        const job = jobs.get(id);
        if (job) updateDownloadState(id, { status: "queued", queuePosition: index + 1 });
    });
}

function drainQueue() {
    while (runningIds.size < maxConcurrentHls && waitingDownloads.length) {
        const id = waitingDownloads.shift();
        const job = jobs.get(id);
        if (!job) continue;
        launchHlsJob(job);
    }
    queuePositions();
}

function finishHlsJob(job) {
    if (!jobs.has(job.id)) return;
    jobs.delete(job.id);
    runningIds.delete(job.id);
    activeDownloads.delete(job.id);
    try { job.port?.disconnect(); } catch (_) {}
    drainQueue();
}

function launchHlsJob(job) {
    let port;
    try {
        port = chrome.runtime.connectNative("com.videocatcher.downloader");
    } catch (error) {
        updateDownloadState(job.id, { status: "error", message: error.message });
        notifyContent(job, { event: "error", ok: false, message: error.message });
        jobs.delete(job.id);
        queueMicrotask(drainQueue);
        return;
    }
    job.port = port;
    runningIds.add(job.id);
    activeDownloads.set(job.id, { port, tabId: job.tabId, frameId: job.frameId });
    updateDownloadState(job.id, { status: "starting", queuePosition: 0 });
    notifyContent(job, { event: "started", ok: true, message: "İndirme sırası geldi." });

    port.onMessage.addListener(nativeMessage => {
        if (!jobs.has(job.id)) return;
        // Duraklatma sırasında gelen gecikmiş FFmpeg progress mesajları
        // popup'taki durumu yeniden "İndiriliyor" yapmasın.
        if (nativeMessage.event === "progress" &&
            ["pausing", "paused", "resuming"].includes(downloadStates.get(job.id)?.status)) return;
        if (nativeMessage.event === "pause_error") {
            updateDownloadState(job.id, { status: downloadStates.get(job.id)?.status === "resuming" ? "paused" : "downloading", message: nativeMessage.message });
            return;
        }
        const status = nativeMessage.event === "progress" || nativeMessage.event === "resumed"
            ? "downloading" : nativeMessage.event;
        updateDownloadState(job.id, {
            status,
            ...(typeof nativeMessage.percent === "number" ? { percent: nativeMessage.percent } : {}),
            ...(typeof nativeMessage.size_bytes === "number" ? { size_bytes: nativeMessage.size_bytes } : {}),
            ...(typeof nativeMessage.speed === "string" ? { speed: nativeMessage.speed } : {}),
            ...(typeof nativeMessage.message === "string" ? { message: nativeMessage.message } : {}),
            ...(nativeMessage.event === "completed" &&
                typeof nativeMessage.message === "string" &&
                nativeMessage.message.startsWith("Indirme tamamlandi: ")
                ? { filePath: nativeMessage.message.slice("Indirme tamamlandi: ".length).trim() }
                : {})
        });
        notifyContent(job, nativeMessage);
        if (["completed", "cancelled", "error"].includes(nativeMessage.event)) finishHlsJob(job);
    });
    port.onDisconnect.addListener(() => {
        if (!jobs.has(job.id)) return;
        const message = chrome.runtime.lastError?.message || "Native host bağlantısı kapandı.";
        updateDownloadState(job.id, { status: "error", message });
        notifyContent(job, { event: "error", ok: false, message });
        finishHlsJob(job);
    });
    try {
        port.postMessage({
            action: "DOWNLOAD_HLS", url: job.url,
            title: job.title.slice(0, 150), quality: job.quality.slice(0, 30)
        });
    } catch (error) {
        updateDownloadState(job.id, { status: "error", message: error.message });
        notifyContent(job, { event: "error", ok: false, message: error.message });
        finishHlsJob(job);
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "START_HLS_DOWNLOAD") return false;
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") {
        sendResponse({ ok: false, message: "Sekme bulunamadı." });
        return false;
    }
    if (typeof message.url !== "string" || !/^https?:\/\//i.test(message.url)) {
        sendResponse({ ok: false, message: "Geçersiz HLS adresi." });
        return false;
    }
    // Depolama yuklenmeden yeni kayit ekleme: onceki kayitlarla yaris olmasin.
    Promise.all([storageReady, settingsReady]).then(() => {
        const id = crypto.randomUUID();
        const job = {
            id, tabId, frameId: sender.frameId ?? 0,
            url: message.url,
            title: typeof message.title === "string" && message.title.trim() ? message.title.trim() : "Video",
            quality: typeof message.quality === "string" && message.quality.trim() ? message.quality.trim() : "Auto",
            port: null
        };
        jobs.set(id, job);
        const queued = runningIds.size >= maxConcurrentHls || waitingDownloads.length > 0;
        updateDownloadState(id, {
            title: job.title, quality: job.quality, tabId,
            status: queued ? "queued" : "starting", percent: 0,
            size_bytes: 0, speed: "", createdAt: Date.now(), queuePosition: 0
        });
        waitingDownloads.push(id);
        drainQueue();
        sendResponse({ ok: true, downloadId: id, queued });
    }).catch(error => sendResponse({ ok: false, message: error.message }));
    return true;
});

// ------------------------------------

// HLS QUALITY DETECTION

// ------------------------------------

chrome.runtime.onMessage.addListener(

    (message, sender, sendResponse) => {

        if (message.type !== "GET_HLS_QUALITIES") {

            return;

        }

        if (

            typeof message.url !== "string" ||

            !/^https?:\/\//i.test(message.url)

        ) {

            sendResponse({

                ok: false,

                message: "Geçersiz HLS adresi."

            });

            return;

        }

        chrome.runtime.sendNativeMessage(

            "com.videocatcher.downloader",

            {

                action: "GET_HLS_QUALITIES",

                url: message.url

            }

        )

        .then(response => {

            console.log(

                "[AndacCatcher] Kalite yanıtı:",

                response

            );

            sendResponse(response);

        })

        .catch(error => {

            console.error(

                "[AndacCatcher] Kalite sorgusu hatası:",

                error

            );

            sendResponse({

                ok: false,

                message: error.message

            });

        });

        return true;

    }

);

// ------------------------------------

// TAB CLEANUP

// ------------------------------------

chrome.tabs.onRemoved.addListener(tabId => {

    mediaByTab.delete(tabId);

});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "CANCEL_HLS_DOWNLOAD") return false;
    const job = jobs.get(message.downloadId);
    const fromPopup = sender.id === chrome.runtime.id && !sender.tab;
    if (!job || (!fromPopup &&
        (job.tabId !== sender.tab?.id || job.frameId !== sender.frameId))) {
        sendResponse({ ok: false, message: "Aktif veya bekleyen indirme bulunamadı." });
        return false;
    }
    if (!runningIds.has(job.id)) {
        const index = waitingDownloads.indexOf(job.id);
        if (index !== -1) waitingDownloads.splice(index, 1);
        jobs.delete(job.id);
        updateDownloadState(job.id, { status: "cancelled", message: "Kuyruktan kaldırıldı.", queuePosition: 0 });
        notifyContent(job, { event: "cancelled", ok: true, message: "Kuyruktan kaldırıldı." });
        drainQueue();
        sendResponse({ ok: true, message: "Bekleyen indirme iptal edildi." });
        return false;
    }
    try {
        job.port.postMessage({ action: "CANCEL_DOWNLOAD" });
        updateDownloadState(job.id, { status: "cancelling" });
        sendResponse({ ok: true, message: "İptal isteği gönderildi." });
    } catch (error) {
        sendResponse({ ok: false, message: error.message });
    }
    return false;
});

// v1.1 popup istekleri
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "VC_GET_DOWNLOADS") {
        storageReady.then(() => {
            sendResponse({ ok: true, downloads: historySnapshot() });
        }).catch(error => sendResponse({ ok: false, message: error.message }));
        return true;
    }

    if (message.type === "VC_CLEAR_FINISHED") {
        storageReady.then(async () => {
            for (const [id, item] of downloadStates) {
                if (FINISHED.has(item.status)) downloadStates.delete(id);
            }
            await persistNow();
            sendResponse({ ok: true });
        }).catch(error => sendResponse({ ok: false, message: error.message }));
        return true;
    }

    if (message.type === "VC_OPEN_DOWNLOADS_FOLDER") {
        chrome.downloads.showDefaultFolder();
        sendResponse({ ok: true });
        return false;
    }

    return false;
});

// v1.2: Tamamlanan dosyayi ac / Explorer'da sec.
// Dosya yolu popup'tan alinmaz; kaydedilmis indirme kaydindan okunur.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "VC_FILE_ACTION") return false;
    if (sender.id !== chrome.runtime.id || sender.tab) {
        sendResponse({ ok: false, message: "Bu islem sadece eklenti arayuzunden yapilabilir." });
        return false;
    }
    if (!["OPEN_FILE", "SHOW_FILE"].includes(message.action)) {
        sendResponse({ ok: false, message: "Gecersiz islem." });
        return false;
    }
    storageReady.then(async () => {
        const item = downloadStates.get(message.downloadId);
        if (!item || item.status !== "completed" || !item.filePath) {
            sendResponse({ ok: false, message: "Bu kayit icin dosya yolu bulunamadi. v1.2 ile yeni bir indirme yapin." });
            return;
        }
        const result = await chrome.runtime.sendNativeMessage(
            "com.videocatcher.downloader",
            { action: message.action, path: item.filePath }
        );
        sendResponse(result?.ok ? { ok: true } : {
            ok: false, message: result?.message || "Dosya islemi basarisiz."
        });
    }).catch(error => sendResponse({ ok: false, message: error.message }));
    return true;
});

// ------------------------------------
// v1.4.1 - Kuyruk yonetimi ve ayarlar
// ------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!["VC_GET_QUEUE_SETTINGS", "VC_SET_CONCURRENCY", "VC_MOVE_QUEUE"].includes(message.type)) return false;
    if (sender.id !== chrome.runtime.id || sender.tab) {
        sendResponse({ ok: false, message: "Yalnizca eklenti arayuzunden kullanilabilir." });
        return false;
    }
    Promise.all([storageReady, settingsReady]).then(async () => {
        if (message.type === "VC_GET_QUEUE_SETTINGS") {
            sendResponse({ ok: true, maxConcurrentHls });
            return;
        }
        if (message.type === "VC_SET_CONCURRENCY") {
            const value = Number(message.value);
            if (![1, 2, 3].includes(value)) {
                sendResponse({ ok: false, message: "Limit 1, 2 veya 3 olmali." });
                return;
            }
            // Once kaydet, sonra limiti uygula.
            await chrome.storage.local.set({ [SETTINGS_KEY]: value });
            maxConcurrentHls = value;
            drainQueue();
            chrome.runtime.sendMessage({ type: "VC_QUEUE_SETTINGS_UPDATED", maxConcurrentHls }).catch(() => {});
            sendResponse({ ok: true, maxConcurrentHls });
            return;
        }
        const index = waitingDownloads.indexOf(message.downloadId);
        if (index < 0 || !jobs.has(message.downloadId)) {
            sendResponse({ ok: false, message: "Bekleyen indirme bulunamadi." });
            return;
        }
        if (!["up", "down"].includes(message.direction)) {
            sendResponse({ ok: false, message: "Gecersiz yon." });
            return;
        }
        const target = index + (message.direction === "up" ? -1 : 1);
        if (target < 0 || target >= waitingDownloads.length) {
            sendResponse({ ok: false, message: "Indirme zaten kuyrugun sinirinda." });
            return;
        }
        [waitingDownloads[index], waitingDownloads[target]] = [waitingDownloads[target], waitingDownloads[index]];
        queuePositions();
        sendResponse({ ok: true });
    }).catch(error => sendResponse({ ok: false, message: error.message }));
    return true;
});

// v1.4.2: Popup uzerinden FFmpeg surecini duraklat/devam ettir.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "VC_TOGGLE_PAUSE") return false;
    if (sender.id !== chrome.runtime.id || sender.tab) {
        sendResponse({ ok: false, message: "Yalnizca eklenti popup'inda kullanilabilir." });
        return false;
    }
    const job = jobs.get(message.downloadId);
    const item = downloadStates.get(message.downloadId);
    if (!job || !runningIds.has(job.id) || !job.port || !item) {
        sendResponse({ ok: false, message: "Aktif indirme bulunamadi." });
        return false;
    }
    const shouldPause = item.status === "downloading" || item.status === "started" || item.status === "starting";
    const shouldResume = item.status === "paused";
    if (!shouldPause && !shouldResume) {
        sendResponse({ ok: false, message: "Indirme su anda duraklatilamaz veya devam ettirilemez." });
        return false;
    }
    try {
        job.port.postMessage({ action: shouldPause ? "PAUSE_DOWNLOAD" : "RESUME_DOWNLOAD" });
        updateDownloadState(job.id, { status: shouldPause ? "pausing" : "resuming" });
        sendResponse({ ok: true });
    } catch (error) {
        sendResponse({ ok: false, message: error.message });
    }
    return false;
});

// v1.5: Gecmisten tek kayit silme. Aktif isler silinemez.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "VC_DELETE_HISTORY_ITEM") return false;
    if (sender.id !== chrome.runtime.id || sender.tab) {
        sendResponse({ ok: false, message: "Yalnizca eklenti arayuzunden kullanilabilir." });
        return false;
    }
    storageReady.then(async () => {
        const item = downloadStates.get(message.downloadId);
        if (!item || !FINISHED.has(item.status)) {
            sendResponse({ ok: false, message: "Yalnizca bitmis indirme kayitlari silinebilir." });
            return;
        }
        downloadStates.delete(message.downloadId);
        await persistNow();
        sendResponse({ ok: true });
    }).catch(error => sendResponse({ ok: false, message: error.message }));
    return true;
});
