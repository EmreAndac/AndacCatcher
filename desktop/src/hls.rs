use serde::Serialize;
use url::Url;

#[derive(Serialize)]
pub struct HlsQuality {
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub bandwidth: u64,
    pub url: String,
}

pub fn get_qualities(master_url: &str) -> Result<Vec<HlsQuality>, String> {
    let parsed_url = Url::parse(master_url).map_err(|e| format!("Gecersiz URL: {e}"))?;

    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err("Yalnizca HTTP/HTTPS destekleniyor".into());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let manifest = client
        .get(master_url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Manifest alinamadi: {e}"))?
        .text()
        .map_err(|e| e.to_string())?;

    parse_master_playlist(master_url, &manifest)
}

fn parse_master_playlist(master_url: &str, manifest: &str) -> Result<Vec<HlsQuality>, String> {
    let base = Url::parse(master_url).map_err(|e| e.to_string())?;
    let mut qualities = Vec::new();
    let mut pending: Option<(u32, u32, u64)> = None;

    for line in manifest.lines() {
        let line = line.trim();

        if let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let mut width = 0;
            let mut height = 0;
            let mut bandwidth = 0;

            for attribute in attributes.split(',') {
                if let Some((key, value)) = attribute.split_once('=') {
                    match key.trim() {
                        "RESOLUTION" => {
                            if let Some((w, h)) = value.split_once('x') {
                                width = w.parse().unwrap_or(0);
                                height = h.parse().unwrap_or(0);
                            }
                        }
                        "BANDWIDTH" => {
                            bandwidth = value.parse().unwrap_or(0);
                        }
                        _ => {}
                    }
                }
            }

            pending = Some((width, height, bandwidth));
            continue;
        }

        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if let Some((width, height, bandwidth)) = pending.take() {
            let absolute_url = base.join(line).map_err(|e| e.to_string())?.to_string();

            qualities.push(HlsQuality {
                label: if height > 0 {
                    format!("{}p", height)
                } else {
                    "Bilinmeyen kalite".into()
                },
                width,
                height,
                bandwidth,
                url: absolute_url,
            });
        }
    }

    qualities.sort_by(|a, b| b.height.cmp(&a.height).then(b.bandwidth.cmp(&a.bandwidth)));

    Ok(qualities)
}
