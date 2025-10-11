use axum::{routing::{post, get, get_service, delete}, Router, extract::{Multipart, Path}, response::IntoResponse, http::StatusCode, Json};
use std::net::SocketAddr;
use chrono::Utc;
use tokio::fs;
use anyhow::Result;
use crate::db::influx::InfluxClient;
use image::io::Reader as ImageReader;
use image::DynamicImage;
use tower_http::services::ServeDir;
use crate::paths;
use serde::{Serialize, Deserialize};
use std::sync::atomic::{AtomicBool, Ordering};

// If Influx is unreachable, we flip this flag to stop further background attempts/logs
static INFLUX_DISABLED_RUNTIME: AtomicBool = AtomicBool::new(false);
static INFLUX_LOGGED_ONCE: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
struct Entry { path: String, sys: i64, dia: i64, pulse: i64, temp_c: f64, timestamp_nanos: i128 }

pub async fn run_server() -> Result<()> {
    let photos_service = get_service(ServeDir::new(paths::PHOTOS_DIR)).handle_error(|err: std::io::Error| async move {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Unhandled internal error: {}", err))
    });

    // Serve the static/ directory so files like /app.js and /dashboard/*.html are available
    let static_service = get_service(ServeDir::new("static")).handle_error(|err: std::io::Error| async move {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Unhandled internal error: {}", err))
    });

    let app = Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .nest_service("/static", static_service)
        .route("/entry", post(handle_entry))
        .route("/entry/:ts", delete(delete_entry))
        .route("/influx_last", get(influx_last))
        .route("/entries", get(list_entries))
        .nest_service("/photos", photos_service);

    let addr = SocketAddr::from(([127,0,0,1], 8081));
    println!("Listening on {}", addr);
    axum::Server::bind(&addr).serve(app.into_make_service()).await?;
    Ok(())
}

async fn root() -> impl IntoResponse {
    let html = include_str!("../static/index.html");
    (axum::http::StatusCode::OK, axum::response::Html(html))
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn handle_entry(mut multipart: Multipart) -> impl IntoResponse {
    // Expected: sys, dia, pulse, temp, photo_front, photo_left, photo_right
    let mut sys: Option<i64> = None;
    let mut dia: Option<i64> = None;
    let mut pulse: Option<i64> = None;
    let mut temp: Option<f64> = None;
    let mut front: Option<Vec<u8>> = None;
    let mut left: Option<Vec<u8>> = None;
    let mut right: Option<Vec<u8>> = None;

    while let Some(field) = multipart.next_field().await.unwrap_or(None) {
        let name = field.name().map(|s| s.to_string()).unwrap_or_default();
        match name.as_str() {
            "sys" => {
                if let Ok(text) = field.text().await {
                    sys = text.parse().ok();
                }
            }
            "dia" => {
                if let Ok(text) = field.text().await {
                    dia = text.parse().ok();
                }
            }
            "pulse" => {
                if let Ok(text) = field.text().await {
                    pulse = text.parse().ok();
                }
            }
            "temp" => {
                if let Ok(text) = field.text().await {
                    temp = text.parse().ok();
                }
            }
            "photo_front" => {
                front = field.bytes().await.ok().map(|b| b.to_vec());
            }
            "photo_left" => {
                left = field.bytes().await.ok().map(|b| b.to_vec());
            }
            "photo_right" => {
                right = field.bytes().await.ok().map(|b| b.to_vec());
            }
            _ => {}
        }
    }

    if sys.is_none() || dia.is_none() || pulse.is_none() || temp.is_none() {
        return (StatusCode::BAD_REQUEST, "Missing numeric fields".to_string());
    }

    let combined_path = match combine_and_save_images(front, left, right, sys.unwrap(), dia.unwrap(), pulse.unwrap(), temp.unwrap()).await {
        Ok(p) => p,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("image error: {}", e)),
    };

    // Optionally write to Influx in the background (can be disabled via env or runtime circuit-breaker)
    let disable_influx_env = std::env::var("VITAL_DISABLE_INFLUX").ok().map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let disable_influx_runtime = INFLUX_DISABLED_RUNTIME.load(Ordering::Relaxed);
    if !disable_influx_env && !disable_influx_runtime {
        let cp = combined_path.clone();
        let s = sys.unwrap(); let d = dia.unwrap(); let p = pulse.unwrap(); let t = temp.unwrap();
        tokio::spawn(async move {
            if let Ok(client) = InfluxClient::from_env() {
                if let Err(e) = client.write_entry(s, d, p, t, &cp).await {
                    let msg = e.to_string();
                    // Detect connection errors and disable future attempts for this session
                    if msg.contains("No connection could be made") || msg.contains("error trying to connect") {
                        INFLUX_DISABLED_RUNTIME.store(true, Ordering::Relaxed);
                        if !INFLUX_LOGGED_ONCE.swap(true, Ordering::Relaxed) {
                            eprintln!(
                                "Influx unreachable; disabling writes for this session. Set VITAL_DISABLE_INFLUX=1 to hide this. ({})",
                                msg
                            );
                        }
                    } else {
                        eprintln!("Influx write failed (background): {}", msg);
                    }
                }
            } else {
                eprintln!("Could not create Influx client (background)");
            }
        });
    }

    (StatusCode::OK, "ok".to_string())
}

async fn list_entries() -> impl IntoResponse {
    let mut out: Vec<Entry> = Vec::new();
    if let Ok(mut files) = fs::read_dir(paths::PHOTOS_DIR).await {
        while let Ok(Some(entry)) = files.next_entry().await {
            if let Ok(md) = entry.metadata().await {
                if md.is_file() {
                    if let Some(fname) = entry.file_name().to_str() {
                        // look for .json metadata file matching the image name
                        if fname.ends_with(".jpg") {
                            let base = fname.trim_end_matches(".jpg");
                            let meta_path_new = paths::json_meta_path(base);
                            let meta_path_legacy = format!("{}/{}.json", paths::PHOTOS_DIR, base);
                            // Try new location first, then legacy next-to-photo JSON
                            let meta_json_res = match fs::read_to_string(&meta_path_new).await {
                                Ok(j) => Ok(j),
                                Err(_) => fs::read_to_string(&meta_path_legacy).await,
                            };
                            if let Ok(j) = meta_json_res {
                                if let Ok(entry_meta) = serde_json::from_str::<Entry>(&j) {
                                    out.push(entry_meta);
                                } else {
                                    // fallback: return minimal entry
                                    let rel = format!("/photos/{}", fname);
                                    if let Ok(ts) = base.parse::<i128>() {
                                        out.push(Entry { path: rel, sys:0, dia:0, pulse:0, temp_c:0.0, timestamp_nanos: ts });
                                    } else {
                                        out.push(Entry { path: rel, sys:0, dia:0, pulse:0, temp_c:0.0, timestamp_nanos:0 });
                                    }
                                }
                            } else {
                                let rel = format!("/photos/{}", fname);
                                if let Ok(ts) = base.parse::<i128>() {
                                    out.push(Entry { path: rel, sys:0, dia:0, pulse:0, temp_c:0.0, timestamp_nanos: ts });
                                } else {
                                    out.push(Entry { path: rel, sys:0, dia:0, pulse:0, temp_c:0.0, timestamp_nanos:0 });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Json(out)
}

async fn influx_last() -> impl IntoResponse {
    match InfluxClient::from_env() {
        Ok(c) => {
            // If an org is configured we assume Influx v2 and use a Flux query.
            // Otherwise fall back to InfluxQL (compatibility API).
            if c.org().is_some() {
                let bucket = c.bucket();
                // Fetch recent points for measurement vital_entry and return the most recent one.
                // This Flux query returns the latest record for the measurement; fields will be
                // returned in separate rows (CSV) which is fine for quick verification.
                let flux = format!(
                    "from(bucket:\"{}\") |> range(start: -30d) |> filter(fn: (r) => r._measurement == \"vital_entry\") |> sort(columns: [\"_time\"], desc: true) |> limit(n:1)",
                    bucket
                );
                match c.query_influxql(&flux).await {
                    Ok(body) => (StatusCode::OK, body),
                    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("query error: {}", e)),
                }
            } else {
                // use InfluxQL compat endpoint to return last point for measurement vital_entry
                let q = "SELECT * FROM vital_entry ORDER BY time DESC LIMIT 1";
                match c.query_influxql(q).await {
                    Ok(body) => (StatusCode::OK, body),
                    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("query error: {}", e)),
                }
            }
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("influx client error: {}", e)),
    }
}

async fn combine_and_save_images(front: Option<Vec<u8>>, left: Option<Vec<u8>>, right: Option<Vec<u8>>, sys: i64, dia: i64, pulse: i64, temp_c: f64) -> Result<String> {
    let photos_dir = paths::PHOTOS_DIR;
    fs::create_dir_all(photos_dir).await?;

    async fn decode_image(bytes: Vec<u8>) -> Result<DynamicImage> {
        let img = ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?.decode()?;
        Ok(img)
    }

    let mut imgs: Vec<DynamicImage> = Vec::new();
    if let Some(b) = front { imgs.push(decode_image(b).await?); }
    if let Some(b) = left { imgs.push(decode_image(b).await?); }
    if let Some(b) = right { imgs.push(decode_image(b).await?); }

    if imgs.is_empty() {
        return Err(anyhow::anyhow!("no images provided"));
    }

    let height = imgs.iter().map(|i| i.height()).max().unwrap_or(0);
    let mut resized: Vec<DynamicImage> = Vec::new();
    for img in imgs {
        let w = ((img.width() as f32) * (height as f32) / (img.height() as f32)) as u32;
        let r = img.resize_exact(w, height, image::imageops::FilterType::Triangle);
        resized.push(r);
    }

    let total_width: u32 = resized.iter().map(|i| i.width()).sum();
    let mut imgbuf = image::RgbImage::new(total_width, height);

    let mut x = 0u32;
    for img in resized {
        let rgb = img.to_rgb8();
        for (px, py, pixel) in rgb.enumerate_pixels() {
            imgbuf.put_pixel(x + px, py, *pixel);
        }
        x += rgb.width();
    }

    let now = Utc::now();
    let secs = now.timestamp() as i128;
    let nsec = now.timestamp_subsec_nanos() as i128;
    let timestamp = secs * 1_000_000_000i128 + nsec;
    let filename = format!("{}.jpg", timestamp);
    let out_path = format!("{}/{}", photos_dir, filename);
    imgbuf.save(&out_path)?;

    // Write metadata JSON under data/json (new layout)
    let meta = Entry { path: format!("/photos/{}", filename), sys: sys, dia: dia, pulse: pulse, temp_c: temp_c, timestamp_nanos: timestamp };
    let meta_path = paths::json_meta_path(&timestamp.to_string());
    let meta_json = serde_json::to_string(&meta)?;
    fs::write(&meta_path, meta_json).await?;

    Ok(out_path)
}

async fn delete_entry(Path(ts): Path<String>) -> impl IntoResponse {
    // Derive file paths from timestamp base
    let photo = format!("{}/{}.jpg", paths::PHOTOS_DIR, ts);
    let meta_new = paths::json_meta_path(&ts);
    let meta_legacy = format!("{}/{}.json", paths::PHOTOS_DIR, ts);

    // Helper to ignore NotFound errors
    async fn rm(p: &str) {
        if let Err(e) = fs::remove_file(p).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("delete failed for {}: {}", p, e);
            }
        }
    }

    rm(&meta_new).await;
    rm(&meta_legacy).await;
    rm(&photo).await;

    StatusCode::NO_CONTENT
}
