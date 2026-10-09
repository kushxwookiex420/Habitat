import test from "node:test";
import assert from "node:assert/strict";
import { createD1SecretVault } from "../d1-secret-vault.mjs";

function fakeD1() {
  const rows = new Map();
  const fetchImpl = async (_url, options) => {
    const { sql, params = [] } = JSON.parse(options.body);
    let results = [];
    if (sql.startsWith("INSERT INTO habitat_secret_vault")) {
      rows.set(params[0], { key_name:params[0], iv:params[1], ciphertext:params[2], auth_tag:params[3], updated_at:params[4] });
    } else if (sql.startsWith("SELECT iv, ciphertext, auth_tag")) {
      const row = rows.get(params[0]);
      results = row ? [{ iv:row.iv, ciphertext:row.ciphertext, auth_tag:row.auth_tag }] : [];
    } else if (sql.startsWith("DELETE FROM habitat_secret_vault")) {
      rows.delete(params[0]);
    } else if (sql.startsWith("SELECT 1")) {
      results = [{ ok:1 }];
    }
    return { ok:true, status:200, async json(){ return { success:true, result:[{ results }] }; } };
  };
  return { rows, fetchImpl };
}

test("D1 secret vault encrypts at rest and decrypts token bundles", async () => {
  const fake = fakeD1();
  const vault = createD1SecretVault({
    accountId:"account", databaseId:"database", apiToken:"api-token",
    encryptionKey:"a".repeat(64), fetchImpl:fake.fetchImpl
  });
  await vault.initialize();
  const tokenBundle = { access_token:"private-access", refresh_token:"private-refresh", expires_in:86400 };
  await vault.set("tiktok_tokens", tokenBundle);
  const row = fake.rows.get("tiktok_tokens");
  assert.ok(row);
  assert.equal(row.ciphertext.includes("private-access"), false);
  assert.deepEqual(await vault.get("tiktok_tokens"), tokenBundle);
  assert.deepEqual(await vault.healthCheck(), { ok:true, adapter:"cloudflare-d1-aes-256-gcm", durable:true });
});

test("D1 secret vault deletes OAuth state records", async () => {
  const fake = fakeD1();
  const vault = createD1SecretVault({
    accountId:"account", databaseId:"database", apiToken:"api-token",
    encryptionKey:"b".repeat(64), fetchImpl:fake.fetchImpl
  });
  await vault.set("state:test", { createdAt:123 });
  assert.deepEqual(await vault.get("state:test"), { createdAt:123 });
  await vault.delete("state:test");
  assert.equal(await vault.get("state:test"), null);
});

test("D1 secret vault rejects weak or malformed encryption keys", () => {
  assert.throws(() => createD1SecretVault({
    accountId:"account", databaseId:"database", apiToken:"api-token", encryptionKey:"too-short"
  }), /64 hexadecimal characters/);
});

test("D1 secret vault never echoes API tokens in query errors", async () => {
  const vault = createD1SecretVault({
    accountId:"account", databaseId:"database", apiToken:"never-log-this",
    encryptionKey:"c".repeat(64),
    fetchImpl:async()=>({ ok:false, status:403, async json(){ return { success:false, errors:[{message:"never-log-this"}] }; } })
  });
  await assert.rejects(vault.initialize(), error => {
    assert.match(error.message,/HTTP 403/);
    assert.equal(error.message.includes("never-log-this"),false);
    return true;
  });
});
