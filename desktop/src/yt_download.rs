use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{ffmpeg_tool, response, send_message, set_process_paused, SharedWriter};

// quality: "best", "720p", "1080p" or a yt-dlp format_id.
fn format_selector(quality: Option<&str>) -> Result<String, String> {
    let value = quality.unwrap_or("best").trim();
    if value.eq_ignore_ascii_case("best") || value.eq_ignore_ascii_case("auto") {
        return Ok("bv[ext=mp4]+ba[ext=m4a]/bv+ba/b".into());
    }
    if let Some(height) = value.strip_suffix('p').and_then(|s| s.parse::<u32>().ok()) {
        if (144..=4320).contains(&height) {
            return Ok(format!("bv[height<={height}][ext=mp4]+ba[ext=m4a]/bv[height<={height}]+ba/b[height<={height}]"));
        }
    }
    if !value.is_empty() && value.len() <= 40 &&
       value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Ok(format!("{value}+ba[ext=m4a]/{value}+ba/{value}"));
    }
    Err("Gecersiz kalite veya format kimligi".into())
}

#[cfg(windows)]
fn terminate_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null()).stderr(Stdio::null()).status();
}
#[cfg(not(windows))]
fn terminate_tree(_pid: u32) {}

pub fn download_video(
    url: &str,
    quality: Option<&str>,
    cancel: Arc<AtomicBool>,
    pause_requested: Arc<AtomicBool>,
    writer: SharedWriter,
) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "Gecersiz video URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Yalnizca HTTP/HTTPS desteklenir".into());
    }
    let selector = format_selector(quality)?;
    let yt_dlp = ffmpeg_tool("yt-dlp");
    let deno = ffmpeg_tool("deno");
    let ffmpeg = ffmpeg_tool("ffmpeg");
    if !deno.is_file() || !ffmpeg.is_file() || !yt_dlp.is_file() {
        return Err("yt-dlp.exe, deno.exe ve ffmpeg.exe uygulama klasorunde bulunmali".into());
    }
    let downloads = std::env::var("USERPROFILE")
        .map_err(|e| e.to_string())?
        .pipe_path_downloads();
    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_millis();
    let output_template = downloads.join(format!(
        "%(title).80s - %(id)s - {}-{}.%(ext)s", stamp, std::process::id()
    ));
    let ffmpeg_dir = ffmpeg.parent().ok_or("FFmpeg klasoru bulunamadi")?;
    let mut child = Command::new(yt_dlp)
        .args(["--no-config", "--no-playlist", "--no-warnings", "--newline",
               "--no-overwrites", "--progress-delta", "0.5", "--merge-output-format", "mp4", "--remux-video", "mp4",
               "--progress-template", "download:AC_PROGRESS|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress._speed_str)s",
               "--js-runtimes"])
        .arg(format!("deno:{}", deno.display()))
        .arg("--ffmpeg-location").arg(ffmpeg_dir)
        .arg("-f").arg(selector)
        .arg("-o").arg(&output_template)
        .arg("--").arg(url)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("yt-dlp baslatilamadi: {e}"))?;
    send_message(&writer, &response("started", true, "Video indirme baslatildi".into()))
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("yt-dlp stdout acilamadi")?;
    let stderr = child.stderr.take().ok_or("yt-dlp stderr acilamadi")?;
    let (tx, rx) = mpsc::channel::<String>();
    let error_tx = tx.clone();
    let output_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line { Ok(line) => { if tx.send(line).is_err() { break; } }, Err(_) => break }
        }
    });
    // yt-dlp progress messages normally arrive on stderr, not stdout.
    // Drain both streams for the entire process lifetime to avoid pipe deadlocks.
    let error_reader = thread::spawn(move || {
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(line) => {
                    if line.contains("AC_PROGRESS|") || line.contains("[Merger]") || line.contains("[VideoRemuxer]") {
                        let _ = error_tx.send(line.clone());
                    }
                    tail.push_str(&line);
                    tail.push('\n');
                    if tail.len() > 32 * 1024 {
                        let start = tail.len() - 16 * 1024;
                        let boundary = tail.char_indices().map(|(i, _)| i)
                            .find(|i| *i >= start).unwrap_or(0);
                        tail.drain(..boundary);
                    }
                }
                Err(_) => break,
            }
        }
        tail
    });
    let mut cancelled = false;
    let mut paused = false;
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            if paused { let _ = set_process_paused(child.id(), false); }
            terminate_tree(child.id());
            let _ = child.kill();
            break child.wait().map_err(|e| e.to_string())?;
        }
        let requested = pause_requested.load(Ordering::SeqCst);
        if requested != paused {
            match set_process_paused(child.id(), requested) {
                Ok(()) => {
                    paused = requested;
                    let event = if paused { "paused" } else { "resumed" };
                    let _ = send_message(&writer, &response(event, true, "Durum degisti".into()));
                }
                Err(error) => {
                    pause_requested.store(paused, Ordering::SeqCst);
                    let _ = send_message(&writer, &response("pause_error", false, error));
                }
            }
        }
        while let Ok(line) = rx.try_recv() {
            if let Some((_, value)) = line.split_once("AC_PROGRESS|") {
                let parts: Vec<&str> = value.trim().splitn(3, '|').collect();
                let mut event = response("progress", true, "Indiriliyor".into());
                if let Some(raw) = parts.first() {
                    // yt-dlp percentage may include ANSI or spaces.
                    let cleaned = raw.trim().trim_end_matches('%').trim();
                    if let Ok(percent) = cleaned.parse::<f64>() {
                        if percent.is_finite() { event.percent = Some(percent.clamp(0.0, 100.0)); }
                    }
                }
                if let Some(raw) = parts.get(1) {
                    event.size_bytes = raw.trim().parse::<u64>().ok();
                }
                if let Some(raw) = parts.get(2) {
                    let speed = raw.trim();
                    if !speed.is_empty() && speed != "NA" && speed != "None" {
                        event.speed = Some(speed.to_string());
                    }
                }
                if event.percent.is_some() || event.size_bytes.is_some() || event.speed.is_some() {
                    let _ = send_message(&writer, &event);
                }
            } else if line.contains("[Merger]") || line.contains("[VideoRemuxer]") {
                let _ = send_message(&writer, &response("started", true, "Ses ve goruntu birlestiriliyor".into()));
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {},
            Err(error) => return Err(error.to_string()),
        }
        thread::sleep(Duration::from_millis(100));
    };
    let _ = output_reader.join();
    let errors = error_reader.join().unwrap_or_default();
    // Drain final progress messages that arrived just before process exit.
    while let Ok(line) = rx.try_recv() {
        if let Some((_, value)) = line.split_once("AC_PROGRESS|") {
            let parts: Vec<&str> = value.trim().splitn(3, '|').collect();
            let mut event = response("progress", true, "Indiriliyor".into());
            event.percent = parts.first().and_then(|s| s.trim().trim_end_matches('%').trim().parse::<f64>().ok())
                .filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 100.0));
            event.size_bytes = parts.get(1).and_then(|s| s.trim().parse::<u64>().ok());
            event.speed = parts.get(2).map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s != "NA" && s != "None");
            if event.percent.is_some() || event.size_bytes.is_some() || event.speed.is_some() {
                let _ = send_message(&writer, &event);
            }
        }
    }
    if cancelled {
        // yt-dlp may create multiple .part/audio/video files; clean only files with our unique suffix.
        let suffix = format!(" - {}-{}", stamp, std::process::id());
        if let Ok(entries) = std::fs::read_dir(&downloads) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.contains(&suffix) && path.is_file() {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
        send_message(&writer, &response("cancelled", true, "Indirme iptal edildi".into()))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    if !status.success() {
        return Err(format!("yt-dlp hata: {}", errors.lines().rev()
            .find(|line| !line.trim().is_empty()).unwrap_or("Bilinmeyen hata")));
    }
    let suffix = format!(" - {}-{}", stamp, std::process::id());
    let completed_file = std::fs::read_dir(&downloads).ok()
        .into_iter().flatten().flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_file() && path.extension()
            .and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
            && path.file_name().and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(&suffix)));
    let file = completed_file.ok_or("yt-dlp basarili bitti ancak MP4 dosyasi bulunamadi")?;
    send_message(&writer, &response("completed", true,
        format!("Indirme tamamlandi: {}", file.display())))
        .map_err(|e| e.to_string())?;
    Ok(())
}

trait DownloadsPath { fn pipe_path_downloads(self) -> std::path::PathBuf; }
impl DownloadsPath for String {
    fn pipe_path_downloads(self) -> std::path::PathBuf {
        std::path::PathBuf::from(self).join("Downloads")
    }
}
