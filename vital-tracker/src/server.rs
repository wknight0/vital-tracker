use axum::{routing::{post, get, get_service}, Router, extract::Multipart, response::IntoResponse, http::StatusCode, Json};
use std::net::SocketAddr;
use uuid::Uuid;
use tokio::fs;
use anyhow::Result;
use crate::db::influx::InfluxClient;
use image::io::Reader as ImageReader;
use image::DynamicImage;
use tower_http::services::ServeDir;
use serde::Serialize;

#[derive(Serialize)]
struct Entry { path: String }

pub async fn run_server() -> Result<()> {
    let photos_service = get_service(ServeDir::new("data/photos")).handle_error(|err: std::io::Error| async move {
        (StatusCode::INTERNAL_SERVER_ERROR, format!("Unhandled internal error: {}", err))
    });

    let app = Router::new()
        .route("/entry", post(handle_entry))
        .route("/entries", get(list_entries))
        .nest_service("/photos", photos_service);

    let addr = SocketAddr::from(([127,0,0,1], 8081));
    println!("Listening on {}", addr);
    axum::Server::bind(&addr).serve(app.into_make_service()).await?;
    Ok(())
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

    let combined_path = match combine_and_save_images(front, left, right).await {
        Ok(p) => p,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("image error: {}", e)),
    };

    let cp = combined_path.clone();
    let s = sys.unwrap(); let d = dia.unwrap(); let p = pulse.unwrap(); let t = temp.unwrap();
    tokio::spawn(async move {
        if let Ok(client) = InfluxClient::from_env() {
            if let Err(e) = client.write_entry(s, d, p, t, &cp).await {
                eprintln!("Influx write failed (background): {}", e);
            }
        } else {
            eprintln!("Could not create Influx client (background)");
        }
    });

    (StatusCode::OK, "ok".to_string())
}

async fn list_entries() -> impl IntoResponse {
    let mut out: Vec<Entry> = Vec::new();
    if let Ok(mut dirs) = fs::read_dir("data/photos").await {
        while let Ok(Some(entry)) = dirs.next_entry().await {
            let p = entry.path().join("combined.jpg");
            if p.exists() {
                if let Some(s) = p.to_str() {
                    out.push(Entry { path: s.to_string() });
                }
            }
        }
    }
    Json(out)
}

async fn combine_and_save_images(front: Option<Vec<u8>>, left: Option<Vec<u8>>, right: Option<Vec<u8>>) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let dir = format!("data/photos/{}", id);
    fs::create_dir_all(&dir).await?;

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

    let out_path = format!("{}/combined.jpg", dir);
    imgbuf.save(&out_path)?;
    Ok(out_path)
}
