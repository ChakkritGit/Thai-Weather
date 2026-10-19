//! RFC 8291 payloads and RFC 8292 VAPID, shared by Dock and bill reminders.
use aes_gcm::{Aes128Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use p256::{
    PublicKey, SecretKey,
    ecdh::diffie_hellman,
    ecdsa::{Signature, SigningKey, signature::Signer},
    elliptic_curve::sec1::ToEncodedPoint,
};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::Sha256;
pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub fn b64(b: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(b)
}
pub fn unb64(s: &str) -> Result<Vec<u8>, Error> {
    Ok(URL_SAFE_NO_PAD.decode(
        s.chars()
            .filter(|c| !c.is_whitespace() && *c != '=')
            .collect::<String>()
            .replace('+', "-")
            .replace('/', "_"),
    )?)
}
pub fn generate() -> Value {
    let key = SecretKey::random(&mut OsRng);
    let point = key.public_key().to_encoded_point(false);
    json!({"publicKey":b64(point.as_bytes()),"privateJwk":{"kty":"EC","crv":"P-256","d":b64(key.to_bytes()),"x":b64(point.x().unwrap()),"y":b64(point.y().unwrap()),"key_ops":["sign"],"ext":true}})
}
fn expand(salt: &[u8], input: &[u8], info: &[u8], out: &mut [u8]) -> Result<(), Error> {
    Hkdf::<Sha256>::new(Some(salt), input)
        .expand(info, out)
        .map_err(|_| "HKDF length".into())
}
fn encrypt_with(
    plain: &[u8],
    peer: &str,
    auth: &str,
    salt: [u8; 16],
    key: SecretKey,
) -> Result<Vec<u8>, Error> {
    let peer = unb64(peer)?;
    let public = key.public_key().to_encoded_point(false);
    let shared = diffie_hellman(
        key.to_nonzero_scalar(),
        PublicKey::from_sec1_bytes(&peer)?.as_affine(),
    );
    let mut info = b"WebPush: info\0".to_vec();
    info.extend(&peer);
    info.extend(public.as_bytes());
    let mut ikm = [0u8; 32];
    expand(&unb64(auth)?, shared.raw_secret_bytes(), &info, &mut ikm)?;
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    expand(&salt, &ikm, b"Content-Encoding: aes128gcm\0", &mut cek)?;
    expand(&salt, &ikm, b"Content-Encoding: nonce\0", &mut nonce)?;
    // One record includes its delimiter and authentication tag, within rs=4096.
    if plain.len() > 4079 {
        return Err("push payload too large".into());
    }
    let mut payload = plain.to_vec();
    payload.push(2);
    let ct = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| "AES key")?
        .encrypt(Nonce::from_slice(&nonce), payload.as_ref())
        .map_err(|_| "push encryption")?;
    let mut body = salt.to_vec();
    body.extend(4096u32.to_be_bytes());
    body.push(65);
    body.extend(public.as_bytes());
    body.extend(ct);
    Ok(body)
}
pub fn encrypt(plain: &[u8], peer: &str, auth: &str) -> Result<Vec<u8>, Error> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    encrypt_with(plain, peer, auth, salt, SecretKey::random(&mut OsRng))
}
pub fn authorization(
    keys: &Value,
    endpoint: &str,
    subject: &str,
    now: i64,
) -> Result<String, Error> {
    let u = url::Url::parse(endpoint)?;
    let aud = u.origin().ascii_serialization();
    let key = SigningKey::from_slice(&unb64(
        keys["privateJwk"]["d"]
            .as_str()
            .ok_or("missing VAPID private key")?,
    )?)?;
    let public = b64(key.verifying_key().to_encoded_point(false).as_bytes());
    if keys["publicKey"] != public {
        return Err("VAPID key mismatch".into());
    }
    let input = format!(
        "{}.{}",
        b64(br#"{"alg":"ES256","typ":"JWT"}"#),
        b64(serde_json::to_vec(
            &json!({"aud":aud,"exp":now+43200,"sub":subject})
        )?)
    );
    let sig: Signature = key.sign(input.as_bytes());
    Ok(format!(
        "vapid t={input}.{}, k={public}",
        b64(sig.to_bytes())
    ))
}
pub fn allowed(endpoint: &str) -> bool {
    url::Url::parse(endpoint).ok().is_some_and(|u| {
        u.scheme() == "https"
            && u.host_str().is_some_and(|h| {
                [
                    "push.apple.com",
                    "fcm.googleapis.com",
                    "googleapis.com",
                    "push.services.mozilla.com",
                    "notify.windows.com",
                ]
                .iter()
                .any(|s| h == *s || h.ends_with(&format!(".{s}")))
            })
    })
}
pub fn client(seconds: u64) -> Result<reqwest::Client, Error> {
    let mut b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(seconds));
    // Optional private CA, also useful for isolated TLS interoperability fixtures.
    if let Ok(path) = std::env::var("SSL_CERT_FILE") {
        b = b.add_root_certificate(reqwest::Certificate::from_pem(&std::fs::read(path)?)?);
    }
    Ok(b.build()?)
}
pub struct Options<'a> {
    pub ttl: &'a str,
    pub topic: Option<&'a str>,
    pub subject: &'a str,
}
pub async fn send(
    client: &reqwest::Client,
    keys: &Value,
    endpoint: &str,
    peer: &str,
    auth: &str,
    msg: &Value,
    options: Options<'_>,
) -> Result<u16, Error> {
    if crate::util::env("PUSH_OUTBOUND_DISABLED", "") == "true" {
        return Err("push outbound disabled".into());
    }
    let u = url::Url::parse(endpoint)?;
    if u.scheme() != "https" {
        return Err("push requires HTTPS".into());
    }
    let body = encrypt(&serde_json::to_vec(msg)?, peer, auth)?;
    let authorization = authorization(
        keys,
        endpoint,
        options.subject,
        crate::checks::millis() / 1000,
    )?;
    let mut r = client
        .post(endpoint)
        .header("authorization", authorization)
        .header("content-encoding", "aes128gcm")
        .header("content-type", "application/octet-stream")
        .header("ttl", options.ttl)
        .header("urgency", "normal")
        .body(body);
    if let Some(t) = options.topic {
        r = r.header("topic", t);
    }
    Ok(r.send().await?.status().as_u16())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc8291_appendix_a() {
        let key =
            SecretKey::from_slice(&unb64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw").unwrap())
                .unwrap();
        let body=encrypt_with(&unb64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24").unwrap(),"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4","BTBZMqHH6r4Tts7J_aSIgg",unb64("DGv6ra1nlYgDCS1FRnbzlw").unwrap().try_into().unwrap(),key).unwrap();
        let mut expected=unb64("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8").unwrap();
        expected.extend(
            unb64(
                "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ",
            )
            .unwrap(),
        );
        assert_eq!(body, expected);
    }
}
