import { getClientId } from "./_lib/kite.js";

export default async function handler(req) {
  return new Response(JSON.stringify({
    clientId: await getClientId()
  }));
}
