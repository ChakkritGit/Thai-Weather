import { nativeApi } from "@/server/native-api";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return nativeApi(request, "/llms-full.txt");
}

export const HEAD = GET;
