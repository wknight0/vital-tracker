use tokio::fs;
pub const JSON_DIR: &str = "data/json";
pub const PHOTOS_DIR: &str = "data/photos";

pub async fn ensure_data_dirs() -> std::io::Result<()> {
    fs::create_dir_all(JSON_DIR).await?;
    fs::create_dir_all(PHOTOS_DIR).await?;
    Ok(())
}

pub fn json_meta_path(base_name: &str) -> String {
    format!("{}/{}.json", JSON_DIR, base_name)
}
