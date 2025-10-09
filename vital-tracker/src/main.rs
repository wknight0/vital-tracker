mod db;
mod server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    server::run_server().await?;
    Ok(())
}
