mod hls;

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
struct DownloadRequest {
    action: String,
    #[serde(default)]
    url: String,
    title: Option<String>,
    quality: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Serialize)]
struct NativeResponse {
    event: String,
    ok: bool,
    message: String,
    seconds: Option<f64>,
    total_seconds: Option<f64>,
    percent: Option<f64>,
    speed: Option<String>,
    size_bytes: Option<u64>,
    qualities: Option<Vec<hls::HlsQuality>>,
}

type SharedWriter = Arc<Mutex<io::Stdout>>;

fn response(event: &str, ok: bool, message: String) -> NativeResponse {
    NativeResponse {
        event: event.to_string(),
        ok,
        message,
        seconds: None,
        total_seconds: None,
        percent: None,
        speed: None,
        size_bytes: None,
        qualities: None,
    }
}

fn read_message() -> io::Result<DownloadRequest> {
    let mut stdin = io::stdin();
    let mut length_bytes = [0u8; 4];

    stdin.read_exact(&mut length_bytes)?;

    let length = u32::from_le_bytes(length_bytes) as usize;

    if length == 0 || length > 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Gecersiz mesaj uzunlugu",
        ));
    }

    let mut buffer = vec![0u8; length];
    stdin.read_exact(&mut buffer)?;

    serde_json::from_slice(&buffer).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

fn send_message(writer: &SharedWriter, message: &NativeResponse) -> io::Result<()> {
    let json = serde_json::to_vec(message)?;
    let length = (json.len() as u32).to_le_bytes();

    let mut stdout = writer
        .lock()
        .map_err(|_| io::Error::other("Stdout kilidi alinamadi"))?;

    stdout.write_all(&length)?;
    stdout.write_all(&json)?;
    stdout.flush()
}

fn probe_duration(url: &str) -> Option<f64> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            url,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v > 0.0)
}

fn sanitize_filename(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        .take(100)
        .collect();

    let cleaned = cleaned.trim().trim_matches('.').trim();

    if cleaned.is_empty() {
        "Video".to_string()
    } else {
        cleaned.to_string()
    }
}

// Windows: FFmpeg surecinin tum threadlerini gecici olarak askida tutar.
// NtSuspendProcess/NtResumeProcess Windows API'leri belgelenmemistir;
// bu nedenle bu surum Windows 10/11 icin deneysel olarak degerlendirilmelidir.
#[cfg(windows)]
fn set_process_paused(pid: u32, paused: bool) -> Result<(), String> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtSuspendProcess(handle: *mut c_void) -> i32;
        fn NtResumeProcess(handle: *mut c_void) -> i32;
    }
    const PROCESS_SUSPEND_RESUME: u32 = 0x0800;
    let handle = unsafe { OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid) };
    if handle.is_null() {
        return Err(format!("FFmpeg surecine erisilemedi: {}", std::io::Error::last_os_error()));
    }
    let result = unsafe {
        if paused { NtSuspendProcess(handle) } else { NtResumeProcess(handle) }
    };
    unsafe { CloseHandle(handle); }
    if result < 0 { return Err(format!("FFmpeg surec durumu degistirilemedi: NTSTATUS {result:#x}")); }
    Ok(())
}

#[cfg(not(windows))]
fn set_process_paused(_pid: u32, _paused: bool) -> Result<(), String> {
    Err("Duraklatma yalnizca Windows'ta destekleniyor".into())
}

fn download_video(
    url: &str,
    title: Option<&str>,
    quality: Option<&str>,
    cancel: Arc<AtomicBool>,
    pause_requested: Arc<AtomicBool>,
    writer: SharedWriter,
) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Gecersiz video adresi".into());
    }

    if cancel.load(Ordering::SeqCst) {
        return Ok(());
    }

    let downloads = std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .map_err(|e| e.to_string())?
        .join("Downloads");

    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    let safe_title = sanitize_filename(title.unwrap_or("Video"));
    let safe_quality = sanitize_filename(quality.unwrap_or("Auto"));

    let filename = format!(
        "{} - {} - {}-{}.mp4",
        safe_title,
        safe_quality,
        timestamp,
        std::process::id()
    );

    let output = downloads.join(filename);

    // FFprobe sürebilir; bu sırada da iptal isteği alınabilir.
    let total_seconds = probe_duration(url);

    if cancel.load(Ordering::SeqCst) {
        return Ok(());
    }

    send_message(
        &writer,
        &response("started", true, "Indirme baslatildi".into()),
    )
    .map_err(|e| e.to_string())?;

    let mut child = Command::new("ffmpeg")
        .args([
            "-y",
            "-nostdin",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-stats_period",
            "0.5",
            "-i",
            url,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
        ])
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().ok_or("FFmpeg cikti kanali acilamadi")?;

    let stderr = child.stderr.take().ok_or("FFmpeg hata kanali acilamadi")?;

    // FFmpeg ilerlemesini ayrı thread'de oku.
    let (tx, rx) = mpsc::channel::<String>();

    let progress_thread = thread::spawn(move || {
        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // stderr dolarsa FFmpeg kilitlenmesin.
    let error_thread = thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buffer = String::new();
        let _ = reader.read_to_string(&mut buffer);
        buffer
    });

    let mut seconds = 0.0_f64;
    let mut speed = String::new();
    let mut size_bytes = 0_u64;
    let mut was_cancelled = false;
    let mut is_paused = false;

    let status = loop {
        // İptal kontrolü
        if cancel.load(Ordering::SeqCst) {
            was_cancelled = true;
            if is_paused { let _ = set_process_paused(child.id(), false); }
            let _ = child.kill();
            break child.wait().map_err(|e| e.to_string())?;
        }

        // Sadece FFmpeg child sureci askida kalir; Rust ana dongusu
        // Native Messaging komutlarini almaya devam eder.
        let requested = pause_requested.load(Ordering::SeqCst);
        if requested != is_paused {
            match set_process_paused(child.id(), requested) {
                Ok(()) => {
                    is_paused = requested;
                    let (event, text) = if requested {
                        ("paused", "Indirme duraklatildi")
                    } else {
                        ("resumed", "Indirme devam ediyor")
                    };
                    send_message(&writer, &response(event, true, text.into()))
                        .map_err(|e| e.to_string())?;
                }
                Err(error) => {
                    // Basarisiz bir pause denemesini her 100 ms'de tekrarlama.
                    pause_requested.store(is_paused, Ordering::SeqCst);
                    send_message(&writer, &response("pause_error", false, error))
                        .map_err(|e| e.to_string())?;
                }
            }
        }

        // Bekleyen ilerleme satırlarını işle.
        while let Ok(line) = rx.try_recv() {
            if let Some((key, value)) = line.split_once('=') {
                match key {
                    "out_time_us" | "out_time_ms" => {
                        if let Ok(value) = value.parse::<f64>() {
                            seconds = value / 1_000_000.0;
                        }
                    }
                    "speed" => {
                        speed = value.to_string();
                    }
                    "total_size" => {
                        size_bytes = value.parse().unwrap_or(0);
                    }
                    "progress" => {
                        let percent =
                            total_seconds.map(|total| (seconds / total * 100.0).clamp(0.0, 100.0));

                        let mut event = response("progress", true, "Indiriliyor".into());

                        event.seconds = Some(seconds);
                        event.total_seconds = total_seconds;
                        event.percent = percent;
                        event.speed = Some(speed.clone());
                        event.size_bytes = Some(size_bytes);

                        send_message(&writer, &event).map_err(|e| e.to_string())?;
                    }
                    _ => {}
                }
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => return Err(error.to_string()),
        }

        thread::sleep(Duration::from_millis(100));
    };

    let _ = progress_thread.join();
    let error_output = error_thread.join().unwrap_or_default();

    if was_cancelled {
        // FFmpeg tamamen kapandıktan sonra dosyayı sil.
        if output.exists() {
            std::fs::remove_file(&output).map_err(|e| format!("Kismi dosya silinemedi: {e}"))?;
        }

        send_message(
            &writer,
            &response("cancelled", true, "Indirme iptal edildi".into()),
        )
        .map_err(|e| e.to_string())?;

        return Ok(());
    }

    if !status.success() {
        let details = error_output
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Bilinmeyen FFmpeg hatasi");

        return Err(format!(
            "FFmpeg hata kodu: {:?}. {}",
            status.code(),
            details
        ));
    }

    send_message(
        &writer,
        &response(
            "completed",
            true,
            format!("Indirme tamamlandi: {}", output.display()),
        ),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(windows)]
fn open_completed_file(path: &str, reveal: bool) -> Result<(), String> {
    use std::ffi::{OsStr, c_void};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let downloads = std::env::var("USERPROFILE").map_err(|e| e.to_string())?;
    let downloads = std::path::Path::new(&downloads).join("Downloads");
    let allowed_dir = std::fs::canonicalize(&downloads)
        .map_err(|e| format!("Indirilenler klasoru bulunamadi: {e}"))?;
    let actual = std::fs::canonicalize(path).map_err(|e| format!("Dosya bulunamadi: {e}"))?;

    // Sadece Video Catcher'in Downloads klasorune kaydettigi MP4'ler.
    if actual.parent() != Some(allowed_dir.as_path())
        || actual
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| !x.eq_ignore_ascii_case("mp4"))
            .unwrap_or(true)
        || !actual
            .file_name()
            .and_then(|x| x.to_str())
            .map(|name| name.contains(" - ") && name.ends_with(".mp4"))
            .unwrap_or(false)
    {
        return Err("Dosya izin verilen Indirilenler klasorunde degil.".into());
    }

    let verb = wide(OsStr::new("open"));
    let explorer = wide(OsStr::new("explorer.exe"));
    let target = wide(actual.as_os_str());

    let result = if reveal {
        // Explorer /select,"C:\\Users\\...\\Downloads\\video.mp4"
        let args = wide(OsStr::new(&format!("/select,\"{}\"", actual.display())));
        unsafe {
            ShellExecuteW(
                ptr::null_mut(),
                verb.as_ptr(),
                explorer.as_ptr(),
                args.as_ptr(),
                ptr::null(),
                1,
            )
        }
    } else {
        unsafe {
            ShellExecuteW(
                ptr::null_mut(),
                verb.as_ptr(),
                target.as_ptr(),
                ptr::null(),
                ptr::null(),
                1,
            )
        }
    };

    if result <= 32 {
        return Err(format!(
            "Windows dosyayi acamadi (ShellExecuteW: {result})."
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_completed_file(_path: &str, _reveal: bool) -> Result<(), String> {
    Err("Bu islem su anda yalnizca Windows'ta destekleniyor.".into())
}

fn main() {
    let writer: SharedWriter = Arc::new(Mutex::new(io::stdout()));

    let cancel = Arc::new(AtomicBool::new(false));
    let pause_requested = Arc::new(AtomicBool::new(false));
    let mut download_thread: Option<thread::JoinHandle<()>> = None;

    loop {
        let request = match read_message() {
            Ok(request) => request,
            Err(error) => {
                // Chrome portu kapatırsa EOF beklenir.
                if error.kind() != io::ErrorKind::UnexpectedEof {
                    let _ = send_message(&writer, &response("error", false, error.to_string()));
                }
                break;
            }
        };

        match request.action.as_str() {
            "DOWNLOAD_HLS" => {
                if download_thread.is_some() {
                    let _ = send_message(
                        &writer,
                        &response("error", false, "Bu baglantida zaten indirme var".into()),
                    );
                    continue;
                }

                cancel.store(false, Ordering::SeqCst);
                pause_requested.store(false, Ordering::SeqCst);

                let url = request.url;
                let title = request.title;
                let quality = request.quality;

                let worker_cancel = Arc::clone(&cancel);
                let worker_pause = Arc::clone(&pause_requested);
                let worker_writer = Arc::clone(&writer);

                download_thread = Some(thread::spawn(move || {
                    if let Err(error) = download_video(
                        &url,
                        title.as_deref(),
                        quality.as_deref(),
                        worker_cancel,
                        worker_pause,
                        Arc::clone(&worker_writer),
                    ) {
                        let _ = send_message(&worker_writer, &response("error", false, error));
                    }
                }));
            }

            "PAUSE_DOWNLOAD" | "RESUME_DOWNLOAD" => {
                if download_thread.is_some() && !cancel.load(Ordering::SeqCst) {
                    let paused = request.action == "PAUSE_DOWNLOAD";
                    pause_requested.store(paused, Ordering::SeqCst);
                    let event = if paused { "pausing" } else { "resuming" };
                    let _ = send_message(&writer, &response(event, true, "Islem iletildi".into()));
                } else {
                    let _ = send_message(&writer, &response("pause_error", false, "Aktif indirme yok".into()));
                }
            }

            "CANCEL_DOWNLOAD" => {
                if download_thread.is_some() {
                    cancel.store(true, Ordering::SeqCst);

                    let _ = send_message(
                        &writer,
                        &response("cancelling", true, "Indirme durduruluyor".into()),
                    );
                } else {
                    let _ = send_message(
                        &writer,
                        &response("error", false, "Aktif indirme bulunamadi".into()),
                    );
                }
            }

            "GET_HLS_QUALITIES" => match hls::get_qualities(&request.url) {
                Ok(qualities) => {
                    let mut result = response(
                        "qualities",
                        true,
                        format!("{} kalite bulundu", qualities.len()),
                    );

                    result.qualities = Some(qualities);
                    let _ = send_message(&writer, &result);
                }
                Err(error) => {
                    let _ = send_message(&writer, &response("error", false, error));
                }
            },

            "OPEN_FILE" | "SHOW_FILE" => {
                let reveal = request.action == "SHOW_FILE";
                let result = request
                    .path
                    .as_deref()
                    .ok_or_else(|| "Dosya yolu gonderilmedi".to_string())
                    .and_then(|path| open_completed_file(path, reveal));

                match result {
                    Ok(()) => {
                        let _ = send_message(
                            &writer,
                            &response("file_action", true, "Islem baslatildi".into()),
                        );
                    }
                    Err(error) => {
                        let _ = send_message(&writer, &response("error", false, error));
                    }
                }
            }

            _ => {
                let _ = send_message(
                    &writer,
                    &response("error", false, "Bilinmeyen islem".into()),
                );
            }
        }
    }

    // Chrome bağlantısı kapanırsa FFmpeg çalışmaya devam etmesin.
    cancel.store(true, Ordering::SeqCst);

    if let Some(handle) = download_thread {
        let _ = handle.join();
    }
}
