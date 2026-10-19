/** Browser-side RFC 8291 decryption, independent of the Rust crypto implementation. */
export async function decryptPush(body:Buffer,pair:CryptoKeyPair,auth:Uint8Array){
 const ua=Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)),sender=body.subarray(21,86),salt=body.subarray(0,16)
 const peer=await crypto.subtle.importKey('raw',sender,{name:'ECDH',namedCurve:'P-256'},false,[])
 const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:peer},pair.privateKey,256))
 const enc=new TextEncoder(),expand=async(salt:Uint8Array,ikm:Uint8Array,info:Uint8Array,n:number)=>{const key=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,n*8))}
 const ikm=await expand(auth,shared,Buffer.concat([enc.encode('WebPush: info\0'),ua,sender]),32),cek=await expand(salt,ikm,enc.encode('Content-Encoding: aes128gcm\0'),16),nonce=await expand(salt,ikm,enc.encode('Content-Encoding: nonce\0'),12)
 const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['decrypt']),plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce},key,body.subarray(86)))
 if(plain.at(-1)!==2)throw new Error('invalid push delimiter')
 return JSON.parse(new TextDecoder().decode(plain.subarray(0,-1)))
}
