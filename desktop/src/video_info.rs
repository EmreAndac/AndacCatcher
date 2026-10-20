use serde::Serialize;
use serde_json::Value;
use std::process::Command;

#[derive(Serialize)]
pub struct VideoFormat {
    pub format_id: String,
    pub ext: String,
    pub height: Option<u64>,
    pub width: Option<u64>,
    pub fps: Option<f64>,
    pub vcodec: String,
    pub acodec: String,
    pub filesize: Option<u64>,
}

#[derive(Serialize)]
pub struct VideoInfo {
    pub id: String,
    pub title: String,
    pub duration: Option<f64>,
    pub extractor: String,
    pub formats: Vec<VideoFormat>,
}

pub fn get_video_info(url: &str) -> Result<VideoInfo, String> {
    let parsed = url::Url::parse(url).map_err(|_| "Gecersiz URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Yalnizca HTTP/HTTPS URL desteklenir".into());
    }
    // The executable is shipped beside the Rust native host.
    let yt_dlp = super::ffmpeg_tool("yt-dlp");
    let deno = super::ffmpeg_tool("deno");

    if !deno.is_file() {
        return Err(format!("Deno bulunamadi: {}", deno.display()));
    }

    let output = Command::new(yt_dlp)
        .arg("--no-config")
        .arg("--no-playlist")
        .arg("--skip-download")
        .arg("--no-warnings")
        .arg("--dump-single-json")
        .arg("--js-runtimes")
        .arg(format!("deno:{}", deno.display()))
        .arg("--")
        .arg(url)
        .output()
        .map_err(|e| format!("yt-dlp baslatilamadi: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp hata: {}",
            err.trim().chars().take(350).collect::<String>()
        ));
    }
    let data: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("yt-dlp JSON okunamadi: {e}"))?;
    let formats = data["formats"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|f| {
                    Some(VideoFormat {
                        format_id: f["format_id"].as_str()?.to_string(),
                        ext: f["ext"].as_str().unwrap_or("unknown").to_string(),
                        height: f["height"].as_u64(),
                        width: f["width"].as_u64(),
                        fps: f["fps"].as_f64(),
                        vcodec: f["vcodec"].as_str().unwrap_or("none").to_string(),
                        acodec: f["acodec"].as_str().unwrap_or("none").to_string(),
                        filesize: f["filesize"]
                            .as_u64()
                            .or_else(|| f["filesize_approx"].as_u64()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(VideoInfo {
        id: data["id"].as_str().unwrap_or("").to_string(),
        title: data["title"].as_str().unwrap_or("Video").to_string(),
        duration: data["duration"].as_f64(),
        extractor: data["extractor"].as_str().unwrap_or("").to_string(),
        formats,
    })
}
