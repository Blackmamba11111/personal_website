/* OIDC 协议层单测：PKCE / 授权地址 / 换码 / ID Token 验签（含负例）
   跑法：node tests/test-oidc.mjs
   说明：验签用例在本地生成 RSA 密钥对自签 JWT，不依赖任何外部平台。 */
import { webcrypto as WC } from 'node:crypto';
import * as P from '../worker/auth-protocols.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  => ' + extra : '')); }
}

/* ---------- base64url ---------- */
function b64u(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uStr(s) { return b64u(new TextEncoder().encode(s)); }

/* ---------- PKCE ---------- */
/* RFC 7636 附录 B 的标准测试向量 */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
check('S256 challenge 与 RFC 7636 测试向量一致',
  await P.oidcChallenge(RFC_VERIFIER) === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  await P.oidcChallenge(RFC_VERIFIER));

const v1 = P.oidcVerifier(), v2 = P.oidcVerifier();
check('verifier 长度符合 43~128 字符规范', v1.length === 43 && v2.length === 43, v1.length + '/' + v2.length);
check('verifier 每次随机', v1 !== v2);
check('verifier 只含 base64url 字符', /^[A-Za-z0-9_-]+$/.test(v1), v1);
check('state 与 nonce 互不相同', P.oidcState() !== P.oidcNonce());

/* ---------- 端点解析 ---------- */
const cfg = { issuer: 'https://sso.example.com/', clientId: 'c1', clientSecret: 's1', scope: 'openid profile email' };
const epDoc = P.oidcEndpoints(cfg, {
  authorization_endpoint: 'https://sso.example.com/auth',
  token_endpoint: 'https://sso.example.com/token',
  jwks_uri: 'https://sso.example.com/jwks',
  userinfo_endpoint: 'https://sso.example.com/me'
});
check('端点缺省时取平台配置文档', epDoc.authorize === 'https://sso.example.com/auth' && epDoc.jwks === 'https://sso.example.com/jwks',
  epDoc.authorize + ' / ' + epDoc.jwks);
check('Issuer 尾部斜杠被归一', epDoc.issuer === 'https://sso.example.com', epDoc.issuer);
const epManual = P.oidcEndpoints(Object.assign({}, cfg, {
  authorizeUrl: 'https://manual/auth', tokenUrl: 'https://manual/token', jwksUri: 'https://manual/jwks'
}), { authorization_endpoint: 'https://doc/auth', token_endpoint: 'https://doc/token', jwks_uri: 'https://doc/jwks' });
check('手工配置优先于平台文档', epManual.authorize === 'https://manual/auth' && epManual.token === 'https://manual/token');

const ep = P.oidcEndpoints(cfg, {
  authorization_endpoint: 'https://sso.example.com/auth?tenant=x',
  token_endpoint: 'https://sso.example.com/token',
  jwks_uri: 'https://sso.example.com/jwks'
});
const authUrl = P.oidcAuthorizeUrl(ep, Object.assign({}, cfg, { extraParams: 'acr_values=urn:mace:incommon:iap:silver' }), {
  redirectUri: 'https://web.aill.top/api/auth/oidc/callback',
  state: 'st1', nonce: 'nc1', challenge: 'ch1'
});
const au = new URL(authUrl);
check('授权地址带齐必需参数', au.searchParams.get('response_type') === 'code'
  && au.searchParams.get('client_id') === 'c1'
  && au.searchParams.get('redirect_uri') === 'https://web.aill.top/api/auth/oidc/callback'
  && au.searchParams.get('state') === 'st1' && au.searchParams.get('nonce') === 'nc1', authUrl);
check('授权地址带 PKCE 参数', au.searchParams.get('code_challenge') === 'ch1'
  && au.searchParams.get('code_challenge_method') === 'S256');
check('授权地址保留端点已有查询串', au.searchParams.get('tenant') === 'x', authUrl);
check('额外参数被合并', au.searchParams.get('acr_values') === 'urn:mace:incommon:iap:silver');
check('不使用 PKCE 时不带 challenge',
  !new URL(P.oidcAuthorizeUrl(ep, cfg, { redirectUri: 'r', state: 's', nonce: 'n', challenge: '' }))
    .searchParams.has('code_challenge'));

/* ---------- 换码 ---------- */
function mockFetch(routes) {
  const hits = [];
  const f = async (url, init) => {
    hits.push({ url: String(url), init: init || {} });
    const key = Object.keys(routes).filter((k) => String(url).indexOf(k) >= 0)[0];
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const r = routes[key];
    return typeof r === 'function' ? r(init) : r;
  };
  f.hits = hits;
  return f;
}
const okToken = { ok: true, status: 200, json: async () => ({ id_token: 'a.b.c', access_token: 'at', token_type: 'Bearer' }) };
const f1 = mockFetch({ '/token': okToken });
const ex1 = await P.oidcExchange(cfg, ep, { code: 'code1', redirectUri: 'https://x/cb', verifier: 'ver1', fetch: f1 });
check('换码成功返回 id_token', ex1.ok && ex1.idToken === 'a.b.c', JSON.stringify(ex1));
const sent = f1.hits[0].init;
check('换码用 form 编码且带 code_verifier',
  /application\/x-www-form-urlencoded/.test(String(sent.headers['content-type'])) &&
  /grant_type=authorization_code/.test(String(sent.body)) &&
  /code_verifier=ver1/.test(String(sent.body)), String(sent.body));
check('默认用 HTTP Basic 传 client_secret',
  /^Basic /.test(String(sent.headers.authorization)) && String(sent.body).indexOf('client_secret=') < 0);
const f2 = mockFetch({ '/token': okToken });
await P.oidcExchange(Object.assign({}, cfg, { tokenAuth: 'post' }), ep, { code: 'c', redirectUri: 'r', fetch: f2 });
check('tokenAuth=post 时密钥进表单',
  String(f2.hits[0].init.body).indexOf('client_secret=s1') >= 0 && !f2.hits[0].init.headers.authorization);
const ex3 = await P.oidcExchange(cfg, ep, { code: 'c', redirectUri: 'r', fetch: mockFetch({ '/token': { ok: true, status: 200, json: async () => ({ access_token: 'at' }) } }) });
check('缺 id_token 明确报错', !ex3.ok && ex3.code === 'noidtoken', JSON.stringify(ex3));
const ex4 = await P.oidcExchange(cfg, ep, { code: 'c', redirectUri: 'r', fetch: mockFetch({ '/token': { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'code 已使用' }) } }) });
check('换码失败带平台原因', !ex4.ok && /code 已使用/.test(ex4.message), ex4.message);

/* ---------- ID Token 验签 ---------- */
const kp = await WC.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']
);
const pubJwk = await WC.subtle.exportKey('jwk', kp.publicKey);
const JWKS = { keys: [Object.assign({}, pubJwk, { kid: 'k1', alg: 'RS256', use: 'sig' })] };

async function signJwt(claims, opts) {
  const o = opts || {};
  const head = b64uStr(JSON.stringify(Object.assign({ alg: 'RS256', kid: 'k1', typ: 'JWT' }, o.head || {})));
  const body = b64uStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(head + '.' + body);
  const sig = await WC.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, kp.privateKey, data);
  return head + '.' + body + '.' + b64u(sig);
}
const NOW = Date.now();
const baseClaims = {
  iss: 'https://sso.example.com', aud: 'c1', sub: 'u-1',
  preferred_username: 'panchao', exp: Math.floor(NOW / 1000) + 300, nonce: 'nc1'
};
const epForVerify = P.oidcEndpoints(cfg, { jwks_uri: 'https://sso.example.com/jwks' });
const expect = { issuer: 'https://sso.example.com', clientId: 'c1', nonce: 'nc1', now: NOW };
const jwksFetch = mockFetch({ '/jwks': { ok: true, status: 200, json: async () => JWKS } });

const goodJwt = await signJwt(baseClaims);
const vOk = await P.oidcVerifyIdToken(cfg, epForVerify, goodJwt, Object.assign({}, expect, { fetch: jwksFetch }));
check('合法令牌验签通过', vOk.ok && vOk.claims.preferred_username === 'panchao', JSON.stringify(vOk).slice(0, 120));
check('点路径取值', P.claimValue({ a: { b: 'x' } }, 'a.b') === 'x' && P.claimValue({ a: 1 }, 'a.b') === '');
check('对象型 claim 不取串', P.claimValue({ g: ['x'] }, 'g') === '');
check('账号 claim 默认取 preferred_username', P.claimValue(vOk.claims, 'preferred_username') === 'panchao');

/* 篡改载荷（把 sub 改掉）→ 签名必须失败 */
const parts = goodJwt.split('.');
const tampered = parts[0] + '.' + b64uStr(JSON.stringify(Object.assign({}, baseClaims, { sub: 'u-2' }))) + '.' + parts[2];
const vTam = await P.oidcVerifyIdToken(cfg, epForVerify, tampered, Object.assign({}, expect, { fetch: jwksFetch }));
check('载荷被篡改时验签失败', !vTam.ok && vTam.code === 'badsig', JSON.stringify(vTam));

const vIss = await P.oidcVerifyIdToken(cfg, epForVerify, await signJwt(Object.assign({}, baseClaims, { iss: 'https://evil.example.com' })), Object.assign({}, expect, { fetch: jwksFetch }));
check('iss 不匹配被拒', !vIss.ok && vIss.code === 'badiss', JSON.stringify(vIss));

const vAud = await P.oidcVerifyIdToken(cfg, epForVerify, await signJwt(Object.assign({}, baseClaims, { aud: 'other' })), Object.assign({}, expect, { fetch: jwksFetch }));
check('aud 不匹配被拒', !vAud.ok && vAud.code === 'badaud', JSON.stringify(vAud));

const vNonce = await P.oidcVerifyIdToken(cfg, epForVerify, await signJwt(Object.assign({}, baseClaims, { nonce: 'nc2' })), Object.assign({}, expect, { fetch: jwksFetch }));
check('nonce 不匹配被拒（防重放）', !vNonce.ok && vNonce.code === 'badnonce', JSON.stringify(vNonce));

const vExp = await P.oidcVerifyIdToken(cfg, epForVerify, await signJwt(Object.assign({}, baseClaims, { exp: Math.floor(NOW / 1000) - 600 })), Object.assign({}, expect, { fetch: jwksFetch }));
check('过期令牌被拒', !vExp.ok && vExp.code === 'expired', JSON.stringify(vExp));

/* alg=none 之类的降级必须拒绝 */
const noneHead = b64uStr(JSON.stringify({ alg: 'none', kid: 'k1' }));
const noneJwt = noneHead + '.' + b64uStr(JSON.stringify(baseClaims)) + '.';
const vNone = await P.oidcVerifyIdToken(cfg, epForVerify, noneJwt, Object.assign({}, expect, { fetch: jwksFetch }));
check('alg=none 被拒', !vNone.ok && vNone.code === 'badalg', JSON.stringify(vNone));

const vNoKey = await P.oidcVerifyIdToken(cfg, epForVerify, await signJwt(baseClaims, { head: { kid: 'other' } }), Object.assign({}, expect, { fetch: jwksFetch }));
check('kid 对不上时拒绝（多密钥场景）', !vNoKey.ok && vNoKey.code === 'nokid', JSON.stringify(vNoKey));

const vNoJwks = await P.oidcVerifyIdToken(cfg, P.oidcEndpoints(cfg, { token_endpoint: 'https://x/t', authorization_endpoint: 'https://x/a' }), goodJwt, Object.assign({}, expect, { fetch: jwksFetch }));
check('缺 JWKS 地址时拒绝', !vNoJwks.ok && vNoJwks.code === 'nojwks', JSON.stringify(vNoJwks));

/* 单密钥且不带 kid：应回退到唯一密钥 */
const single = mockFetch({ '/jwks': { ok: true, status: 200, json: async () => ({ keys: [Object.assign({}, pubJwk, { alg: 'RS256' })] }) } });
const vSingle = await P.oidcVerifyIdToken(cfg, epForVerify, goodJwt, Object.assign({}, expect, { fetch: single }));
check('平台只给一个密钥且无 kid 时可用', vSingle.ok === true, JSON.stringify(vSingle).slice(0, 120));

/* discovery 失败要给出可读提示 */
const dFail = await P.oidcDiscovery({ issuer: 'https://sso.example.com', timeout: 3 },
  { fetch: mockFetch({ '/.well-known/openid-configuration': { ok: false, status: 502, json: async () => ({}) } }) });
check('配置文档取不到时说明状态码', !dFail.ok && /502/.test(dFail.message), dFail.message);
check('Issuer 非法时直接拒绝', (await P.oidcDiscovery({ issuer: 'sso.example.com' })).code === 'badissuer');

console.log('<<通过 ' + pass + ' / 共 ' + (pass + fail) + '>>');
if (fail) process.exitCode = 1;
