// Modules only the status Worker's bundler (wrangler) provides.
declare module 'cloudflare:email' {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string)
  }
}
declare module '*.png' {
  const bytes: ArrayBuffer
  export default bytes
}
