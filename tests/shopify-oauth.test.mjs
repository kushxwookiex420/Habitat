import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildShopifyAuthorizationUrl, buildShopifyStatus, normalizeShopDomain, registerShopifyOAuth, SHOPIFY_REDIRECT_URI, SHOPIFY_SCOPES, verifyShopifyCallbackHmac } from "../shopify-oauth.mjs";
function response(){return {statusCode:200,headers:{},status(n){this.statusCode=n;return this;},type(v){this.contentType=v;return this;},setHeader(k,v){this.headers[k]=v;},json(v){this.body=v;return this;},send(v){this.body=v;return this;},redirect(n,u){this.statusCode=n;this.redirectUrl=u;return this;}};}
function app(){const routes=new Map();return {routes,get(p,h){routes.set(p,h);}};}
function vault(){const records=new Map();return {durable:true,records,async set(k,v){records.set(k,structuredClone(v));},async get(k){return records.has(k)?structuredClone(records.get(k)):null;},async delete(k){records.delete(k);}};}
function sign(q,s){const msg=Object.keys(q).filter(k=>k!=="hmac"&&k!=="signature").sort().map(k=>k+"="+q[k]).join("&");return crypto.createHmac("sha256",s).update(msg).digest("hex");}
test("only accepts exact Shopify shop domains",()=>{assert.equal(normalizeShopDomain("https://drop-pilot.myshopify.com/"),"drop-pilot.myshopify.com");assert.equal(normalizeShopDomain("drop-pilot.myshopify.com.attacker.test"),"");});
test("authorization URL requests read-only product scope and registered callback",()=>{const u=new URL(buildShopifyAuthorizationUrl({shop:"drop-pilot.myshopify.com",clientId:"client",state:"nonce"}));assert.equal(u.origin+u.pathname,"https://drop-pilot.myshopify.com/admin/oauth/authorize");assert.equal(u.searchParams.get("redirect_uri"),SHOPIFY_REDIRECT_URI);assert.deepEqual(u.searchParams.get("scope").split(","),SHOPIFY_SCOPES);});
test("callback HMAC rejects tampering",()=>{const q={code:"abc",shop:"drop-pilot.myshopify.com",state:"nonce",timestamp:"123"};q.hmac=sign(q,"secret");assert.equal(verifyShopifyCallbackHmac(q,"secret"),true);assert.equal(verifyShopifyCallbackHmac({...q,code:"tampered"},"secret"),false);});
test("status does not expose tokens or secrets",()=>{const s=buildShopifyStatus({clientId:"private-id",clientSecret:"private-secret",token:{shop:"drop-pilot.myshopify.com",access_token:"private-token",scope:"read_products"},vaultReady:true});assert.equal(s.connected,true);assert.equal(JSON.stringify(s).includes("private-secret"),false);assert.equal(JSON.stringify(s).includes("private-token"),false);});
test("connect route saves state before redirect",async()=>{const oldK=process.env.SHOPIFY_API_KEY,oldS=process.env.SHOPIFY_API_SECRET;process.env.SHOPIFY_API_KEY="test-client";process.env.SHOPIFY_API_SECRET="test-secret";try{const a=app(),v=vault();registerShopifyOAuth(a,v);const r=response();await a.routes.get("/auth/shopify")({headers:{},query:{shop:"drop-pilot.myshopify.com"}},r);assert.equal(r.statusCode,302);assert.match(r.headers["Set-Cookie"],/HttpOnly; Secure; SameSite=Lax/);const state=new URL(r.redirectUrl).searchParams.get("state");assert.ok(v.records.has("shopify_oauth_state:"+state));}finally{if(oldK===undefined)delete process.env.SHOPIFY_API_KEY;else process.env.SHOPIFY_API_KEY=oldK;if(oldS===undefined)delete process.env.SHOPIFY_API_SECRET;else process.env.SHOPIFY_API_SECRET=oldS;}});
test("callback rejects invalid signature before token exchange",async()=>{const a=app();registerShopifyOAuth(a,vault(),{fetchImpl:async()=>{throw Error("must not call");}});const r=response();await a.routes.get("/auth/shopify/callback")({headers:{cookie:"habitat_shopify_state=wrong"},query:{code:"x",shop:"drop-pilot.myshopify.com",state:"wrong"}},r);assert.equal(r.statusCode,400);assert.match(String(r.body),/signature check failed/i);});


test("catalog route requests 100 products and forwards pagination cursor",async()=>{
  const a=app(),v=vault();
  await v.set("shopify_tokens:drop-pilot.myshopify.com",{shop:"drop-pilot.myshopify.com",access_token:"token",scope:"read_products"});
  let sent;
  registerShopifyOAuth(a,v,{fetchImpl:async(url,options)=>{
    sent={url,options};
    return {ok:true,status:200,json:async()=>({data:{products:{edges:[{node:{id:"gid://shopify/Product/1",title:"Test product",handle:"test-product",vendor:"DropPilot",status:"ACTIVE",totalInventory:4,featuredImage:null,priceRangeV2:{minVariantPrice:{amount:"19.99",currencyCode:"USD"}}}}],pageInfo:{hasNextPage:true,endCursor:"next-cursor"}}}})};
  }});
  const r=response();
  await a.routes.get("/shopify/products")({query:{shop:"drop-pilot.myshopify.com",cursor:"prior-cursor"}},r);
  assert.equal(r.statusCode,200);
  const body=JSON.parse(sent.options.body);
  assert.match(body.query,/products\(first: 100, after: \$after/);
  assert.equal(body.variables.after,"prior-cursor");
  assert.equal(r.body.productCountReturned,1);
  assert.equal(r.body.hasNextPage,true);
  assert.equal(r.body.endCursor,"next-cursor");
});
