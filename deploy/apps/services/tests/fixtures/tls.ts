import {execFileSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
/** Fresh private test CA and a leaf with proper server extensions; never disables certificate checks. */
export function fixtureTls(root:string){
 const provided=process.env.CHAT_FIXTURE_TLS_DIR
 if(provided)return provided
 const run=(args:string[])=>execFileSync('openssl',args,{cwd:root,stdio:'ignore'})
 run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca-key.pem','-out','cert.pem','-days','1','-subj','/CN=Fixture CA','-addext','basicConstraints=critical,CA:TRUE'])
 run(['req','-newkey','rsa:2048','-nodes','-keyout','key.pem','-out','leaf.csr','-subj','/CN=localhost'])
 writeFileSync(join(root,'extensions.txt'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
 run(['x509','-req','-in','leaf.csr','-CA','cert.pem','-CAkey','ca-key.pem','-CAcreateserial','-out','server.pem','-days','1','-extfile','extensions.txt'])
 return root
}
