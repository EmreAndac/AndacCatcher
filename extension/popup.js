const list = document.getElementById("list");
const summary = document.getElementById("summary");
const clear = document.getElementById("clear");
const states = new Map();
const concurrency = document.getElementById("concurrency");
const search = document.getElementById("search");
const statusFilter = document.getElementById("statusFilter");
let maxConcurrentHls = 3;
const terminal = new Set(["completed", "cancelled", "error", "interrupted"]);
const labels = {
    queued: "Sırada", starting: "Başlatılıyor", started: "Hazırlanıyor",
    downloading: "İndiriliyor", progress: "İndiriliyor",
    cancelling: "İptal ediliyor", cancelled: "İptal edildi",
    completed: "Tamamlandı", error: "Hata",
    interrupted: "Kesintiye uğradı", pausing: "Duraklatılıyor", paused: "Duraklatıldı", resuming: "Devam ettiriliyor"
};
const mb = n => ((Number(n) || 0) / 1048576).toFixed(1) + " MB";

function render() {
    list.replaceChildren();
    const items = [...states.values()].sort((a, b) => {
        if (a.status === "queued" && b.status === "queued") return (a.queuePosition || 0) - (b.queuePosition || 0);
        return (b.createdAt || 0) - (a.createdAt || 0);
    });
    const running = items.filter(x => !terminal.has(x.status) && x.status !== "queued").length;
    const queued = items.filter(x => x.status === "queued").length;
    summary.textContent = `${running}/${maxConcurrentHls} aktif · ${queued} sırada · ${items.length} kayıt`;
    clear.disabled = !items.some(x => terminal.has(x.status));

    if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Henüz indirme yok. Bir video üzerinden indirme başlat.";
        list.append(empty);
        return;
    }

    const query = search.value.trim().toLocaleLowerCase("tr-TR");
    const visible = items.filter(item => {
        const title = `${item.title || ""} ${item.quality || ""}`.toLocaleLowerCase("tr-TR");
        if (query && !title.includes(query)) return false;
        switch (statusFilter.value) {
            case "active": return !terminal.has(item.status) && item.status !== "queued";
            case "queued": return item.status === "queued";
            case "completed": return item.status === "completed";
            case "stopped": return ["cancelled", "error", "interrupted"].includes(item.status);
            default: return true;
        }
    });
    if (!visible.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Filtreye uygun indirme bulunamadı.";
        list.append(empty);
    }
    for (const item of visible) {
        const card = document.createElement("article");
        card.className = "item";
        const top = document.createElement("div");
        top.className = "top";
        const name = document.createElement("div");
        name.className = "name";
        name.textContent = `${item.title || "Video"} · ${item.quality || "Auto"}`;
        const status = document.createElement("span");
        status.className = "state";
        status.textContent = item.status === "queued" ? `Sırada #${item.queuePosition || "?"}` : (labels[item.status] || item.status || "Bekleniyor");
        top.append(name, status);

        const track = document.createElement("div");
        track.className = "track";
        const fill = document.createElement("div");
        fill.className = "fill";
        const percent = Number.isFinite(item.percent) ? Math.min(100, Math.max(0, item.percent)) : 0;
        fill.style.width = `${item.status === "completed" ? 100 : percent}%`;
        if (item.status === "cancelled" || item.status === "interrupted") {
            fill.classList.add("stopped");
        }
        track.append(fill);

        const meta = document.createElement("div");
        meta.className = "meta";
        const left = document.createElement("span");
        left.textContent = `${item.status === "completed" ? "100" : percent.toFixed(1)}% · ${mb(item.size_bytes)}`;
        const right = document.createElement("span");
        right.textContent = item.status === "completed" ? "Tamamlandı" :
            terminal.has(item.status) || ["paused", "pausing", "resuming"].includes(item.status) ? "" : (item.speed || "");
        meta.append(left, right);
        card.append(top, track, meta);

        if (["error", "interrupted"].includes(item.status) && item.message) {
            const error = document.createElement("div");
            error.className = "state";
            error.textContent = item.message;
            card.append(error);
        }

        const actions = document.createElement("div");
        actions.className = "actions";
        if (!terminal.has(item.status)) {
            if (item.status === "queued") {
                for (const [direction, text, disabled] of [
                    ["up", "↑ Öne Al", item.queuePosition <= 1],
                    ["down", "↓ Geri Al", item.queuePosition >= queued]
                ]) {
                    const move = document.createElement("button");
                    move.className = "move";
                    move.textContent = text;
                    move.disabled = disabled;
                    move.addEventListener("click", async () => {
                        move.disabled = true;
                        try {
                            const result = await chrome.runtime.sendMessage({ type: "VC_MOVE_QUEUE", downloadId: item.id, direction });
                            if (!result?.ok) throw new Error(result?.message || "Siralanamadi");
                        } catch (error) {
                            status.textContent = error.message;
                            move.disabled = false;
                        }
                    });
                    actions.append(move);
                }
            }
            if (["starting", "started", "downloading", "paused"].includes(item.status)) {
                const pause = document.createElement("button");
                pause.className = "pause";
                pause.textContent = item.status === "paused" ? "▶ Devam Et" : "⏸ Duraklat";
                pause.addEventListener("click", async () => {
                    pause.disabled = true;
                    try {
                        const result = await chrome.runtime.sendMessage({
                            type: "VC_TOGGLE_PAUSE", downloadId: item.id
                        });
                        if (!result?.ok) throw new Error(result?.message || "Islem basarisiz");
                    } catch (error) {
                        status.textContent = error.message;
                        pause.disabled = false;
                    }
                });
                actions.append(pause);
            }
            const cancel = document.createElement("button");
            cancel.className = "cancel";
            cancel.textContent = item.status === "cancelling" ? "İptal ediliyor..." : item.status === "queued" ? "Kuyruktan Çıkar" : "İptal Et";
            cancel.disabled = item.status === "cancelling";
            cancel.addEventListener("click", async () => {
                cancel.disabled = true;
                try {
                    const result = await chrome.runtime.sendMessage({
                        type: "CANCEL_HLS_DOWNLOAD", downloadId: item.id
                    });
                    if (!result?.ok) throw new Error(result?.message || "İptal başarısız");
                } catch (error) {
                    cancel.disabled = false;
                    status.textContent = error.message;
                }
            });
            actions.append(cancel);
        } else if (item.status === "completed") {
            if (item.filePath) {
                for (const [action, label] of [
                    ["OPEN_FILE", "▶ Videoyu Aç"],
                    ["SHOW_FILE", "📁 Konumunu Göster"]
                ]) {
                    const control = document.createElement("button");
                    control.className = "folder";
                    control.textContent = label;
                    control.addEventListener("click", async () => {
                        control.disabled = true;
                        try {
                            const result = await chrome.runtime.sendMessage({
                                type: "VC_FILE_ACTION", action, downloadId: item.id
                            });
                            if (!result?.ok) throw new Error(result?.message || "İşlem başarısız.");
                        } catch (error) {
                            status.textContent = error.message;
                        } finally {
                            control.disabled = false;
                        }
                    });
                    actions.append(control);
                }
            } else {
                const folder = document.createElement("button");
                folder.className = "folder";
                folder.textContent = "İndirilenler klasörünü aç";
                folder.addEventListener("click", async () => {
                    try {
                        const result = await chrome.runtime.sendMessage({ type: "VC_OPEN_DOWNLOADS_FOLDER" });
                        if (!result?.ok) throw new Error("Klasör açılamadı");
                    } catch (error) { status.textContent = error.message; }
                });
                actions.append(folder);
            }
        }
        if (terminal.has(item.status)) {
            const remove = document.createElement("button");
            remove.className = "remove";
            remove.textContent = "Kaydı Sil";
            remove.title = "Yalnızca geçmiş kaydını siler, indirilen dosyaya dokunmaz.";
            remove.addEventListener("click", async () => {
                remove.disabled = true;
                try {
                    const result = await chrome.runtime.sendMessage({
                        type: "VC_DELETE_HISTORY_ITEM", downloadId: item.id
                    });
                    if (!result?.ok) throw new Error(result?.message || "Kayıt silinemedi.");
                    states.delete(item.id);
                    render();
                } catch (error) {
                    status.textContent = error.message;
                    remove.disabled = false;
                }
            });
            actions.append(remove);
        }
        if (actions.childElementCount) card.append(actions);
        list.append(card);
    }
}

search.addEventListener("input", render);
statusFilter.addEventListener("change", render);

concurrency.addEventListener("change", async () => {
    const value = Number(concurrency.value);
    concurrency.disabled = true;
    try {
        const result = await chrome.runtime.sendMessage({ type: "VC_SET_CONCURRENCY", value });
        if (!result?.ok) throw new Error(result?.message || "Ayar kaydedilemedi");
        maxConcurrentHls = result.maxConcurrentHls;
        render();
    } catch (error) {
        concurrency.value = String(maxConcurrentHls);
        summary.textContent = error.message;
    } finally { concurrency.disabled = false; }
});

chrome.runtime.onMessage.addListener(message => {
    if (message.type === "VC_QUEUE_SETTINGS_UPDATED") {
        maxConcurrentHls = message.maxConcurrentHls;
        concurrency.value = String(maxConcurrentHls);
        render();
        return;
    }
    if (message.type !== "VC_DOWNLOAD_UPDATED" || !message.download) return;
    states.set(message.download.id, message.download);
    render();
});

clear.addEventListener("click", async () => {
    try {
        const result = await chrome.runtime.sendMessage({ type: "VC_CLEAR_FINISHED" });
        if (!result?.ok) throw new Error(result?.message || "Temizleme başarısız");
        for (const [id, x] of states) {
            if (terminal.has(x.status)) states.delete(id);
        }
        render();
    } catch (error) { summary.textContent = error.message; }
});

(async () => {
    try {
        const [response, settings] = await Promise.all([
            chrome.runtime.sendMessage({ type: "VC_GET_DOWNLOADS" }),
            chrome.runtime.sendMessage({ type: "VC_GET_QUEUE_SETTINGS" })
        ]);
        if (settings?.ok) {
            maxConcurrentHls = settings.maxConcurrentHls;
            concurrency.value = String(maxConcurrentHls);
        }
        if (!response?.ok) throw new Error(response?.message || "Liste alınamadı");
        for (const item of response.downloads || []) {
            const current = states.get(item.id);
            if (!current || (item.updatedAt || 0) >= (current.updatedAt || 0)) {
                states.set(item.id, item);
            }
        }
        render();
    } catch (error) { summary.textContent = "Bağlantı hatası: " + error.message; }
})();
