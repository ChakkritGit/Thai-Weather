import { createPublicApi } from "@/lib/publicApi";
import { llmsResponse } from "./llmsResponse";
import { fullTextResponse } from "./fullTextResponse";
import { feedResponse } from "./feedResponse";

export const publicApi = createPublicApi({ llms: llmsResponse, fullText: fullTextResponse, feed: feedResponse });
