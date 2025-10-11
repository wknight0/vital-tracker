mod db;
mod server;
mod paths;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load environment variables from .env if present
    let _ = dotenvy::dotenv();
    // Ensure data directories exist
    paths::ensure_data_dirs().await?;
    if let Err(e) = server::run_server().await {
        eprintln!("Server failed to start: {:#}", e);
        std::process::exit(1);
    }
    Ok(())
}
