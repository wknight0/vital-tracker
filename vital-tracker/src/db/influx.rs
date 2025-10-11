use anyhow::{anyhow, Result};
use chrono::Utc;
use reqwest::Client;
use std::env;

pub struct InfluxClient {
    url: String,
    token: Option<String>,
    org: Option<String>,
    bucket: String,
    client: Client,
}

impl InfluxClient {
    pub fn from_env() -> Result<Self> {
        let url = env::var("INFLUX_URL").unwrap_or_else(|_| "http://localhost:8086".to_string());
        let token = env::var("INFLUX_TOKEN").ok();
        let org = env::var("INFLUX_ORG").ok();
        let bucket = env::var("INFLUX_BUCKET").unwrap_or_else(|_| "default".to_string());

        Ok(InfluxClient {
            url,
            token,
            org,
            bucket,
            client: Client::new(),
        })
    }

    pub fn org(&self) -> Option<&String> {
        self.org.as_ref()
    }

    pub fn bucket(&self) -> &str {
        &self.bucket
    }

    #[allow(dead_code)]
    pub async fn write_point(&self, measurement: &str, metric: &str, value: f64) -> Result<()> {
        let now = Utc::now();
        let timestamp = now.timestamp_nanos_opt().unwrap_or(now.timestamp() * 1_000_000_000);
        let line = format!("{measurement},metric={metric} value={value} {timestamp}",
            measurement = measurement,
            metric = metric,
            value = value,
            timestamp = timestamp
        );

        let write_url = if self.org.is_some() {
            format!("{}/api/v2/write?org={}&bucket={}&precision=ns", self.url, self.org.as_ref().unwrap(), self.bucket)
        } else {
            format!("{}/write?db={}", self.url, self.bucket)
        };

        let mut req = self.client.post(&write_url).body(line);

        if let Some(token) = &self.token {
            req = req.header("Authorization", format!("Token {}", token));
        }

        let resp = req.send().await.map_err(|e| anyhow!(e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("Influx write failed: {} - {}", status, body));
        }

        Ok(())
    }

    /// Writes full vital entry storing numeric fields and photo path
    pub async fn write_entry(&self, sys: i64, dia: i64, pulse: i64, temp_c: f64, photo_path: &str) -> Result<()> {
        let now = Utc::now();
        let timestamp = now.timestamp_nanos_opt().unwrap_or(now.timestamp() * 1_000_000_000);

        let escaped = photo_path.replace('"', "\\\"");
        let line = format!(
            "vital_entry sys={},dia={},pulse={},temp_c={},photo=\"{}\" {}",
            sys, dia, pulse, temp_c, escaped, timestamp
        );

        let write_url = if self.org.is_some() {
            format!("{}/api/v2/write?org={}&bucket={}&precision=ns", self.url, self.org.as_ref().unwrap(), self.bucket)
        } else {
            format!("{}/write?db={}", self.url, self.bucket)
        };

        let mut req = self.client.post(&write_url).body(line);
        if let Some(token) = &self.token {
            req = req.header("Authorization", format!("Token {}", token));
        }

        let resp = req.send().await.map_err(|e| anyhow!(e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("Influx write failed: {} - {}", status, body));
        }
        Ok(())
    }

    /// Simple compatibility query using InfluxQL returning csv text
    pub async fn query_influxql(&self, q: &str) -> Result<String> {
        if self.org.is_some() {
            let url = format!("{}/api/v2/query?org={}", self.url, self.org.as_ref().unwrap());
            let mut req = self.client.post(&url)
                .header("Content-Type", "application/vnd.flux")
                .header("Accept", "application/csv")
                .body(q.to_string());
            if let Some(token) = &self.token {
                req = req.header("Authorization", format!("Token {}", token));
            }
            let resp = req.send().await.map_err(|e| anyhow!(e))?;
            let status = resp.status();
            let body = resp.text().await.map_err(|e| anyhow!(e))?;
            if !status.is_success() {
                return Err(anyhow!("Influx query failed: {} - {}", status, body));
            }
            return Ok(body);
        } else {
            let url = format!("{}/query?db={}", self.url, self.bucket);
            let mut req = self.client.post(&url).form(&[("q", q)]);
            if let Some(token) = &self.token {
                req = req.header("Authorization", format!("Token {}", token));
            }
            let resp = req.send().await.map_err(|e| anyhow!(e))?;
            let status = resp.status();
            let body = resp.text().await.map_err(|e| anyhow!(e))?;
            if !status.is_success() {
                return Err(anyhow!("Influx query failed: {} - {}", status, body));
            }
            return Ok(body);
        }
    }
}
