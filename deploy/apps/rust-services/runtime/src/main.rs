mod analytics;
mod backup;
mod chat;
mod chat_report;
mod checks;
mod client;
mod dbgw;
mod health;
mod media;
mod playback;
mod push;
mod reminders;
mod rooms;
mod sync;
mod util;

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let service = std::env::args().nth(1).unwrap_or_else(|| "health".into());
    let default_port = match service.as_str() {
        "health" => 8789,
        "media" => 8793,
        "analytics" => 8790,
        "dbgw" => 8791,
        "backup" => 8794,
        "rooms" => 8787,
        "sync" => 8788,
        "chat" => 8795,
        "reminders" => 8792,
        _ => return Err("unknown service".into()),
    };
    let port = util::env("PORT", &default_port.to_string()).parse()?;
    if std::env::args().any(|a| a == "--healthcheck") {
        return util::healthcheck(
            port,
            match service.as_str() {
                "health" => "/ping",
                "rooms" => "/__health",
                _ => "/health",
            },
        );
    }
    match service.as_str() {
        "health" => health::run().await,
        "media" => util::serve(port, media::router()).await,
        "analytics" => util::serve(port, analytics::router()?).await,
        "dbgw" => util::serve(port, dbgw::router()?).await,
        "backup" => util::serve(port, backup::router()?).await,
        "rooms" => util::serve(port, rooms::router()).await,
        "sync" => util::serve(port, sync::router()?).await,
        "chat" => {
            util::serve(
                port,
                chat::router().map_err(|e| -> Box<dyn std::error::Error> { e })?,
            )
            .await
        }
        "reminders" => {
            util::serve(
                port,
                reminders::router().map_err(|e| -> Box<dyn std::error::Error> { e })?,
            )
            .await
        }
        _ => unreachable!(),
    }
}
