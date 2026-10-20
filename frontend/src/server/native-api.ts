import { createNativeApiProxy } from "@/lib/native-api";

export const nativeApi = createNativeApiProxy(
  () => process.env.THWX_WEB_API_URL || "http://weather-web-api:8801",
);
