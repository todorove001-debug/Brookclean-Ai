import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SmsAero } from "./sms.ts";

test("SMS Aero: номер без плюса, basic-авторизация, ошибка провайдера пробрасывается", async () => {
  const calls: Array<{ url: string; auth: string }> = [];
  const srv = createServer((req, res) => {
    calls.push({ url: req.url!, auth: req.headers.authorization ?? "" });
    const ok = !req.url!.includes("79990000000");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(ok ? { success: true, data: {} } : { success: false, message: "Invalid number" }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  const sms = new SmsAero("me@example.com", "key", "Brookclean", `http://127.0.0.1:${port}/v2`);

  await sms.send("+79135551234", "Код: 1234");
  const u = new URL(calls[0].url, "http://x");
  assert.equal(u.pathname, "/v2/sms/send");
  assert.equal(u.searchParams.get("number"), "79135551234");
  assert.equal(u.searchParams.get("sign"), "Brookclean");
  assert.equal(calls[0].auth, "Basic " + Buffer.from("me@example.com:key").toString("base64"));
  await assert.rejects(sms.send("+79990000000", "x"), /Invalid number/);
  srv.close();
});
