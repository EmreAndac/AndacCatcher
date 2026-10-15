
console.log("[AndacCatcher] CONTENT SCRIPT LOADED", location.href);
document.documentElement.dataset.videoCatcherLoaded = "true";
const registeredVideos = new WeakSet();
function reportUrl(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        return;
    }
    chrome.runtime.sendMessage({
        type: "DOM_MEDIA_FOUND",
        url
    }).catch(error => {
        console.warn("[AndacCatcher] Kaynak bildirilemedi:", error.message);
    });
}
function reportVideoSources(video) {
    reportUrl(video.currentSrc);
    reportUrl(video.src);
    video.querySelectorAll("source").forEach(source => {
        reportUrl(source.src);
    });
}
function positionButton(video, button) {
    const rect = video.getBoundingClientRect();
    const visible =
        rect.width >= 150 &&
        rect.height >= 100 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
    if (!visible) {
        button.style.display = "none";
        return false;
    }
    button.style.display = "block";
    const width = button.offsetWidth || 130;
    button.style.top =
        `${Math.max(10, rect.top + 10)}px`;
    button.style.left =
        `${Math.max(10, rect.right - width - 10)}px`;
    return true;
}
function getVideoTitle(video) {
    const text = value => typeof value === "string" ? value.trim() : "";
    const parent = video.closest("figure, article, [data-video-title], [data-title]");
    const caption = parent?.querySelector("figcaption, [data-video-title], .video-title, .title");
    const candidates = [
        video.getAttribute("data-title"),
        video.getAttribute("title"),
        video.getAttribute("aria-label"),
        parent?.getAttribute("data-video-title"),
        parent?.getAttribute("data-title"),
        caption?.getAttribute("data-video-title"),
        caption?.textContent
    ];
    const ownTitle = candidates.map(text).find(Boolean);
    if (ownTitle) return ownTitle.slice(0, 150);

    const pageTitle = text(document.querySelector('meta[property="og:title"]')?.content)
        || text(document.title) || "Video";
    const videos = [...document.querySelectorAll("video")];
    const index = videos.indexOf(video);
    // Sayfada birden fazla video varsa ayni sayfa basligini tekrarlama.
    return (videos.length > 1 && index >= 0
        ? `${pageTitle} - Video ${index + 1}`
        : pageTitle).slice(0, 150);
}
function registerVideo(video) {
    if (registeredVideos.has(video)) return;
    registeredVideos.add(video);
    reportVideoSources(video);
    // İndirme butonu
    const button = document.createElement("button");
    button.className = "video-catcher-button";
    button.textContent = "⬇ Videoyu İndir";
    document.documentElement.appendChild(button);
    // Kalite seçim paneli
    const qualityPanel = document.createElement("div");
    qualityPanel.className = "vc-quality-panel";
    qualityPanel.style.display = "none";
    qualityPanel.innerHTML = `
        <div class="vc-quality-header">
            <strong>AndacCatcher</strong>
            <button type="button" class="vc-quality-close">✕</button>
        </div>
        <div class="vc-quality-description">
            İndirmek istediğiniz kaliteyi seçin
        </div>
        <div class="vc-quality-options"></div>
        <div class="vc-quality-actions">
            <button type="button" class="vc-quality-download">
                ⬇ İndirmeyi Başlat
            </button>
        </div>
        <div class="vc-quality-error"></div>
    `;
    // Paneli ekran sinirlari icinde tut; uzun kalite listesi kendi icinde kayar.
    qualityPanel.style.setProperty("position", "fixed", "important");
    qualityPanel.style.setProperty("box-sizing", "border-box");
    qualityPanel.style.setProperty("max-height", "calc(100vh - 16px)");
    qualityPanel.style.setProperty("overflow", "hidden");
    qualityPanel.style.setProperty("flex-direction", "column");
    qualityPanel.style.setProperty("width", "min(280px, calc(100vw - 16px))");
    document.documentElement.appendChild(qualityPanel);
    // Flex kolon: sadece secenekler kayar, baslat dugmesi gorunur kalir.
    const optionsArea = qualityPanel.querySelector(".vc-quality-options");
    optionsArea.style.setProperty("overflow-y", "auto");
    optionsArea.style.setProperty("min-height", "0");
    optionsArea.style.setProperty("flex", "1 1 auto");
    qualityPanel.querySelector(".vc-quality-header").style.flexShrink = "0";
    qualityPanel.querySelector(".vc-quality-description").style.flexShrink = "0";
    qualityPanel.querySelector(".vc-quality-actions").style.flexShrink = "0";
    qualityPanel.querySelector(".vc-quality-error").style.flexShrink = "0";
    const qualityOptions =
        qualityPanel.querySelector(".vc-quality-options");
    const qualityDownloadButton =
        qualityPanel.querySelector(".vc-quality-download");
    const qualityCloseButton =
        qualityPanel.querySelector(".vc-quality-close");
    const qualityError =
        qualityPanel.querySelector(".vc-quality-error");
    // İlerleme paneli
    const downloadProgress = document.createElement("div");
    downloadProgress.className = "video-catcher-progress";
    downloadProgress.innerHTML = `
        <div class="vc-progress-header">
            <span class="vc-progress-title">Video indiriliyor</span>
            <span class="vc-progress-percent">0%</span>
        </div>
        <div class="vc-progress-track">
            <div class="vc-progress-fill"></div>
        </div>
        <div class="vc-progress-details">
            <span class="vc-progress-size">0 MB</span>
            <span class="vc-progress-speed">Hazırlanıyor...</span>
        </div>
            <button type="button" class="vc-cancel-button">İndirmeyi İptal Et</button>
    `;
    document.documentElement.appendChild(downloadProgress);
    const progressTitle =
        downloadProgress.querySelector(".vc-progress-title");
    const progressPercent =
        downloadProgress.querySelector(".vc-progress-percent");
    const progressFill =
        downloadProgress.querySelector(".vc-progress-fill");
    const progressSize =
        downloadProgress.querySelector(".vc-progress-size");
    const progressSpeed =
        downloadProgress.querySelector(".vc-progress-speed");
    const cancelButton = downloadProgress.querySelector(".vc-cancel-button");
    let cancelPending = false;
    let terminalTimer = null;
    function resetCancelButton() {
        cancelPending = false;
        cancelButton.disabled = false;
        cancelButton.textContent = "İndirmeyi İptal Et";
        cancelButton.style.display = "block";
    }
    function finishDownload() {
        currentDownloadId = null;
        cancelButton.style.display = "none";
        setButtonIdle();
        clearTimeout(terminalTimer);
        terminalTimer = setTimeout(() => {
            if (!currentDownloadId) downloadProgress.style.display = "none";
        }, 3500);
    }
    cancelButton.addEventListener("click", async () => {
        if (!currentDownloadId || cancelPending) return;
        cancelPending = true;
        cancelButton.disabled = true;
        cancelButton.textContent = "İptal ediliyor...";
        try {
            const result = await chrome.runtime.sendMessage({
                type: "CANCEL_HLS_DOWNLOAD",
                downloadId: currentDownloadId
            });
            if (!result?.ok) throw new Error(result?.message || "İptal isteği başarısız.");
        } catch (error) {
            cancelPending = false;
            cancelButton.disabled = false;
            cancelButton.textContent = "İndirmeyi İptal Et";
            progressSpeed.textContent = `İptal hatası: ${error.message}`;
        }
    });
    let currentDownloadId = null;
    let availableQualities = [];
    let selectedQualityIndex = 0;
    let loading = false;
    const earlyEvents = [];
    let startingDownload = false;
    function setButtonIdle() {
        button.disabled = false;
        button.textContent = "⬇ Videoyu İndir";
    }
    function showError(message) {
        qualityError.textContent = message;
        qualityError.style.display = "block";
    }
    function resetProgress() {
        progressTitle.textContent = "Video indiriliyor";
        progressPercent.textContent = "0%";
        progressFill.style.width = "0%";
        progressSize.textContent = "0 MB";
        progressSpeed.textContent = "Hazırlanıyor...";
        resetCancelButton();
        clearTimeout(terminalTimer);
    }
    function updatePosition() {
        if (!video.isConnected) {
            button.remove();
            qualityPanel.remove();
            downloadProgress.remove();
            return;
        }
        const visible = positionButton(video, button);
        if (!visible) {
            qualityPanel.style.display = "none";
            downloadProgress.style.display = "none";
            return;
        }
        const rect = button.getBoundingClientRect();
        const panelWidth = 280;
        const left = Math.max(
            8,
            Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 8)
        );
        qualityPanel.style.left = `${left}px`;
        if (qualityPanel.style.display !== "none") {
            qualityPanel.style.display = "flex";
            const viewportGap = 8;
            const below = window.innerHeight - rect.bottom - viewportGap * 2;
            const above = rect.top - viewportGap * 2;
            // Panelin dogal boyunu olc; uzun liste icin mevcut alan kadar yukseklik ayir.
            qualityPanel.style.maxHeight = "calc(100vh - 16px)";
            const naturalHeight = qualityPanel.scrollHeight;
            const openAbove = below < Math.min(naturalHeight, 300) && above > below;
            const available = Math.max(110, openAbove ? above : below);
            qualityPanel.style.maxHeight = `${Math.min(available, window.innerHeight - 16)}px`;
            if (openAbove) {
                qualityPanel.style.top = `${Math.max(viewportGap, rect.top - Math.min(naturalHeight, available) - viewportGap)}px`;
            } else {
                qualityPanel.style.top = `${Math.max(viewportGap, Math.min(rect.bottom + viewportGap, window.innerHeight - viewportGap - Math.min(naturalHeight, available)))}px`;
            }
        }
        downloadProgress.style.left =
            `${Math.max(8, Math.min(rect.left, window.innerWidth - 260))}px`;
        downloadProgress.style.top = `${rect.bottom + 6}px`;
    }
    function renderQualities() {
        qualityOptions.replaceChildren();
        availableQualities.forEach((quality, index) => {
            const label = document.createElement("label");
            label.className = "vc-quality-option";
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = `vc-quality-${video.dataset.vcId}`;
            radio.value = String(index);
            radio.checked = index === selectedQualityIndex;
            radio.addEventListener("change", () => {
                selectedQualityIndex = index;
            });
            const description = document.createElement("span");
            description.className = "vc-quality-option-text";
            const title = document.createElement("strong");
            title.textContent = quality.label || "Bilinmeyen kalite";
            const detail = document.createElement("small");
            const resolution =
                quality.width && quality.height
                    ? `${quality.width} × ${quality.height}`
                    : "Çözünürlük belirtilmemiş";
            const bitrate =
                quality.bandwidth
                    ? ` • ${(quality.bandwidth / 1000000).toFixed(2)} Mbps`
                    : "";
            detail.textContent = resolution + bitrate;
            description.append(title, detail);
            label.append(radio, description);
            qualityOptions.appendChild(label);
        });
    }
    async function startHlsDownload(url) {
        if (loading || currentDownloadId) return;
        loading = true;
        startingDownload = true;
        earlyEvents.length = 0;
        qualityDownloadButton.disabled = true;
        button.disabled = true;
        button.textContent = "⏳ İndiriliyor...";
        try {
            const selectedQuality = availableQualities[selectedQualityIndex];
            const response = await chrome.runtime.sendMessage({
                type: "START_HLS_DOWNLOAD",
                url,
                title: getVideoTitle(video),
                quality: selectedQuality?.label || "Auto"
            });
            if (!response?.ok || !response.downloadId) {
                throw new Error(
                    response?.message || "İndirme başlatılamadı."
                );
            }
            currentDownloadId = response.downloadId;
            startingDownload = false;
            qualityPanel.style.display = "none";
            resetProgress();
            downloadProgress.style.display = "block";
            updatePosition();
            for (const event of earlyEvents.splice(0)) {
                if (event.downloadId === currentDownloadId) handleDownloadMessage(event);
            }
        } catch (error) {
            startingDownload = false;
            console.error("[AndacCatcher] İndirme hatası:", error);
            setButtonIdle();
            showError(error.message);
            qualityPanel.style.display = "flex";
            downloadProgress.style.display = "none";
        } finally {
            loading = false;
            qualityDownloadButton.disabled = false;
        }
    }
    async function openQualityPanel() {
        if (loading || currentDownloadId) return;
        reportVideoSources(video);
        qualityError.style.display = "none";
        qualityPanel.style.display = "flex";
        qualityOptions.textContent = "Kaliteler aranıyor...";
        qualityDownloadButton.disabled = true;
        loading = true;
        button.disabled = true;
        button.textContent = "⏳ Kaliteler aranıyor...";
        try {
            // Yalnizca BU video elementinin dogrudan bildirdigi adresler.
            // Baska videolarin ag isteklerini eslestirmeye calismiyoruz.
            const ownUrls = [...new Set([
                video.currentSrc,
                video.src,
                ...[...video.querySelectorAll("source")].map(source => source.src),
                video.getAttribute("data-hls-url"),
                video.getAttribute("data-src")
            ].filter(url => typeof url === "string" && /^https?:\/\//i.test(url)))];
            const ownHls = ownUrls.filter(url => /\.m3u8(?:[?#]|$)/i.test(url));
            // MIME tipi HLS olan, uzantisiz adresleri de kabul et.
            for (const source of video.querySelectorAll("source")) {
                if (/mpegurl/i.test(source.type || "") && /^https?:\/\//i.test(source.src) && !ownHls.includes(source.src)) {
                    ownHls.push(source.src);
                }
            }
            // blob: kaynaklari HLS.js tarafindan kullanilabilir; bu durumda
            // agda yakalanmis manifestleri yalnizca tek video varsa dene.
            const singleVideo = document.querySelectorAll("video").length === 1;
            const hlsSources = await chrome.runtime.sendMessage({
                type: "GET_HLS", urls: ownHls, singleVideo
            });
            const candidates = ownHls.map(url => ({ url }));
            if (Array.isArray(hlsSources)) {
                for (const item of hlsSources) {
                    if (!candidates.some(x => x.url === item.url)) candidates.push(item);
                }
            }
            if (candidates.length === 0) {
                const direct = ownUrls.find(url => /\.(mp4|webm)(?:[?#]|$)/i.test(url));
                if (direct) {
                    qualityPanel.style.display = "none";
                    const response = await chrome.runtime.sendMessage({ type: "DOWNLOAD_DIRECT", url: direct });
                    if (!response?.ok) throw new Error(response?.error || "Doğrudan indirme başarısız.");
                    return;
                }
                throw new Error(singleVideo
                    ? "HLS bağlantısı ağ isteklerinde bulunamadı. Sayfayı yenileyip tekrar deneyin."
                    : "Birden fazla video var ve bu videonun HLS adresi eşleştirilemedi. Yanlış video indirilmeyecek.");
            }
            let qualities = [];
            let fallbackUrl = candidates[0].url;
            for (const source of candidates.slice(0, 10)) {
                try {
                    const response = await chrome.runtime.sendMessage({
                        type: "GET_HLS_QUALITIES",
                        url: source.url
                    });
                    if (
                        response?.ok &&
                        Array.isArray(response.qualities) &&
                        response.qualities.length > 0
                    ) {
                        qualities = response.qualities;
                        fallbackUrl = source.url;
                        break;
                    }
                } catch (error) {
                    console.warn(
                        "[AndacCatcher] Manifest sorgulanamadı:",
                        error.message
                    );
                }
            }
            if (qualities.length === 0) {
                // Tek varyantlı HLS manifestleri kalite listesi içermez.
                qualities = [{
                    label: "Varsayılan kalite",
                    width: 0,
                    height: 0,
                    bandwidth: 0,
                    url: fallbackUrl
                }];
            }
            availableQualities = qualities;
            selectedQualityIndex = 0;
            renderQualities();
            qualityDownloadButton.disabled = false;
            qualityPanel.style.display = "flex";
            updatePosition();
        } catch (error) {
            console.error("[AndacCatcher] Kaynak hatası:", error);
            showError(error.message);
            qualityOptions.textContent = "";
            qualityPanel.style.display = "flex";
        } finally {
            loading = false;
            setButtonIdle();
            updatePosition();
        }
    }
    button.addEventListener("click", openQualityPanel);
    qualityCloseButton.addEventListener("click", () => {
        qualityPanel.style.display = "none";
    });
    qualityDownloadButton.addEventListener("click", () => {
        const selected = availableQualities[selectedQualityIndex];
        if (!selected?.url) {
            showError("Geçerli bir kalite seçilemedi.");
            return;
        }
        startHlsDownload(selected.url);
    });
    function handleDownloadMessage(message) {
        if (message.event === "started") {
            progressTitle.textContent = "Video indiriliyor";
            progressPercent.textContent = "Hazırlanıyor";
            progressSpeed.textContent = "Başlatılıyor...";
            downloadProgress.style.display = "block";
        }
        if (message.event === "progress" && !cancelPending) {
            const percent =
                typeof message.percent === "number" &&
                Number.isFinite(message.percent)
                    ? Math.max(0, Math.min(100, message.percent))
                    : null;
            progressTitle.textContent = "Video indiriliyor";
            progressPercent.textContent =
                percent === null
                    ? "Hesaplanıyor"
                    : `${percent.toFixed(1)}%`;
            progressFill.style.width = `${percent ?? 0}%`;
            progressSize.textContent =
                `${((message.size_bytes || 0) / 1048576).toFixed(1)} MB`;
            progressSpeed.textContent =
                message.speed || "Hesaplanıyor";
            downloadProgress.style.display = "block";
        }
        if (message.event === "cancelling") {
            progressTitle.textContent = "İndirme durduruluyor";
            progressSpeed.textContent = "FFmpeg kapatılıyor...";
            cancelPending = true;
            cancelButton.disabled = true;
            cancelButton.textContent = "İptal ediliyor...";
        }
        if (message.event === "cancelled") {
            progressTitle.textContent = "İndirme iptal edildi";
            progressPercent.textContent = "İptal";
            progressSpeed.textContent = "Kısmi dosya temizlendi";
            finishDownload();
        }
        if (message.event === "completed") {
            progressTitle.textContent = "✓ İndirme tamamlandı";
            progressPercent.textContent = "100%";
            progressFill.style.width = "100%";
            progressSpeed.textContent = "Tamamlandı";
            finishDownload();
        }
        if (message.event === "error") {
            progressTitle.textContent = "✕ İndirme başarısız";
            progressPercent.textContent = "Hata";
            progressSpeed.textContent =
                message.message || "Bilinmeyen hata";
            finishDownload();
        }
        updatePosition();
    }
    chrome.runtime.onMessage.addListener(message => {
        if (message.type !== "DOWNLOAD_PROGRESS") return;
        if (startingDownload && !currentDownloadId) {
            earlyEvents.push(message);
            return;
        }
        if (message.downloadId !== currentDownloadId) return;
        handleDownloadMessage(message);
    });
    video.addEventListener("loadedmetadata", () => {
        reportVideoSources(video);
        updatePosition();
    });
    video.addEventListener("play", () => {
        reportVideoSources(video);
        updatePosition();
    });
    window.addEventListener("scroll", updatePosition, {
        passive: true
    });
    window.addEventListener("resize", updatePosition);
    updatePosition();
}
let videoCounter = 0;
function scanVideos() {
    document.querySelectorAll("video").forEach(video => {
        if (!video.dataset.vcId) {
            video.dataset.vcId = String(++videoCounter);
        }
        registerVideo(video);
    });
}
scanVideos();
const observer = new MutationObserver(scanVideos);
observer.observe(document.documentElement, {
    childList: true,
    subtree: true
});
