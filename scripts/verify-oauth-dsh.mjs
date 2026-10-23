// Local-only real DSH Loader smoke for issue #21. No browser or model request.
// Usage: node scripts/verify-oauth-dsh.mjs <DSH npm prefix> <plugin lib/index.js>
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { spawn } from 'node:child_process';

const runtime = resolve(process.argv[2]);
const host = resolve(process.argv[3]);
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version, '0.2.1-rc.2');
const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-issue21-loader-'));
const workspace = join(scratch, 'workspace');
mkdirSync(workspace);
const resultPath = join(scratch, 'result.json');
const verifier = join(scratch, 'verify.mjs');
writeFileSync(verifier, `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const name = 'issue21-verifier';
export const inject = ['agents', 'agentLoop', 'webServer'];
export function apply(ctx) {
 void (async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async fn => { for(let i=0;i<200;i++){if(await fn())return;await sleep(50);}throw Error('smoke condition timed out'); };
  let owned;
  let registrations = 0;
  let exchanges = 0;
  let refreshes = 0;
  let liveToken = 'synthetic-access';
  const methods = [];
  let authUrl;
  let redirect;
  const server = createServer((req,res) => {
    let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{
     const base='http://127.0.0.1:'+server.address().port;
     const send=(status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(typeof body==='string'?body:JSON.stringify(body));};
     try {
      if(req.url==='/.well-known/oauth-protected-resource/mcp') return send(200,{resource:base+'/mcp',authorization_servers:[base+'/issuer']});
      if(req.url==='/.well-known/oauth-authorization-server/issuer') return send(200,{issuer:base+'/issuer',authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',registration_endpoint:base+'/register',code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
      if(req.url==='/register') {
       registrations++;
       const body=JSON.parse(raw);
       if(body.application_type!=='native') return send(400,{error:'invalid_client_metadata',error_description:'HTTP loopback callback requires native'});
       assert.equal(body.token_endpoint_auth_method,'none');
       assert.match(body.client_name,/^dsh-mcp-manager-/);
       redirect=body.redirect_uris[0];
       return send(201,{client_id:'synthetic-client',redirect_uris:[redirect]});
      }
      if(req.url==='/token') {
       const form=new URLSearchParams(raw);
       if(form.get('grant_type')==='refresh_token') {
        refreshes++;
        assert.equal(form.get('client_id'),'synthetic-manual-client');
        assert.equal(form.get('refresh_token'),'synthetic-refresh');
        assert.equal(form.get('resource'),base+'/mcp');
        liveToken='synthetic-refreshed-access';
        return send(200,{access_token:liveToken,refresh_token:'synthetic-rotated-refresh',expires_in:3600,token_type:'Bearer'});
       }
       exchanges++;
       assert.equal(form.get('grant_type'),'authorization_code');
       assert.equal(form.get('code'),'synthetic-code');
       assert.equal(form.get('redirect_uri'),redirect);
       assert.equal(form.get('client_id'),exchanges===1?'synthetic-client':'synthetic-manual-client');
       assert.equal(form.get('resource'),base+'/mcp');
       assert.equal(form.get('client_secret'),null);
       assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),authUrl.searchParams.get('code_challenge'));
       return send(200,{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,token_type:'Bearer'});
      }
      if(req.url==='/mcp') {
       if(req.headers.authorization!=='Bearer '+liveToken) return send(401,{error:'unauthorized'},{'WWW-Authenticate':'Bearer resource_metadata="'+base+'/.well-known/oauth-protected-resource/mcp"'});
       const msg=JSON.parse(raw||'{}');
       methods.push(msg.method);
       if(msg.id===undefined) return send(202,'');
       const result=msg.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'isolated-oauth',version:'1'}}:msg.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{};
       return send(200,{jsonrpc:'2.0',id:msg.id,result});
      }
      return send(404,{error:'not_found'});
     } catch(error) { return send(500,{error:String(error)}); }
    });
  });
  try {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    await until(async()=>ctx.webServer.port && (await fetch(ctx.webServer.getOrigin()+'/mcp-manager/api/ping')).ok);
    owned=await ctx.agents.create({sessionId:'issue21-isolated',meta:{cwd:${JSON.stringify(workspace)}}});
    const origin=ctx.webServer.getOrigin();
    const api=origin+'/mcp-manager/api';
    const created=await fetch(api+'/servers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'local_oauth',type:'http',url:'http://127.0.0.1:'+server.address().port+'/mcp',authMode:'oauth',scope:'synthetic.read'})});
    assert.equal(created.status,201);
    const id=(await created.json()).server.id;
    const auth=await fetch(api+'/servers/'+id+'/auth',{method:'POST'});
    const authBody=await auth.json();
    assert.equal(auth.status,200,JSON.stringify(authBody));
    authUrl=new URL(authBody.authorizeUrl);
    assert.equal(authUrl.searchParams.get('client_id'),'synthetic-client');
    assert.equal(authUrl.searchParams.get('resource'),'http://127.0.0.1:'+server.address().port+'/mcp');
    assert.equal(authUrl.searchParams.get('scope'),'synthetic.read');
    assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256');
    assert.equal(authUrl.searchParams.get('redirect_uri'),redirect);
    assert.equal(new URL(redirect).origin,origin);
    const callback=await fetch(redirect+'?code=synthetic-code&state='+authUrl.searchParams.get('state'));
    assert.match(await callback.text(),/Authorized/);
    const view=(await (await fetch(api+'/servers')).json()).servers.find(s=>s.id===id);
    assert.equal(view.status,'connected');
    assert.equal(view.toolCount,1);
    await until(()=>owned.agent.ctx.tools.schemas(owned.agent).some(t=>t.name==='mcp__local_oauth__echo'));
    const persisted=JSON.parse(readFileSync(join(${JSON.stringify(scratch)},'.dsh','mcp-manager.json'))).servers.find(s=>s.id===id);
    assert.equal(persisted.oauth.clientId,'synthetic-client');
    assert.equal(persisted.oauth.tokens.access_token,'synthetic-access');
    assert.equal(exchanges,1);
    assert.equal(registrations,1);
    const reauth=await fetch(api+'/servers/'+id+'/auth',{method:'POST'});
    assert.equal(reauth.status,200);
    assert.equal(registrations,1);
    const logs=(await (await fetch(api+'/servers/'+id+'/logs')).json()).logs;
    for(const phase of ['register','token-exchange','tools/list']) assert.ok(logs.some(l=>l.phase===phase),phase);
    for(const method of ['initialize','notifications/initialized','tools/list']) assert.ok(methods.includes(method),method);
    const manualCreated=await fetch(api+'/servers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'manual_oauth',type:'http',url:'http://127.0.0.1:'+server.address().port+'/mcp',authMode:'oauth',clientId:'synthetic-manual-client'})});
    assert.equal(manualCreated.status,201);
    const manualId=(await manualCreated.json()).server.id;
    const manualAuth=await fetch(api+'/servers/'+manualId+'/auth',{method:'POST'});
    assert.equal(manualAuth.status,200);
    authUrl=new URL((await manualAuth.json()).authorizeUrl);
    redirect=authUrl.searchParams.get('redirect_uri');
    assert.equal(authUrl.searchParams.get('client_id'),'synthetic-manual-client');
    const manualCallback=await fetch(redirect+'?code=synthetic-code&state='+authUrl.searchParams.get('state'));
    assert.match(await manualCallback.text(),/Authorized/);
    assert.equal(registrations,1,'manual clients must skip dynamic registration');
    liveToken='synthetic-expired-access';
    const manualReconnect=await fetch(api+'/servers/'+manualId+'/connect',{method:'POST'});
    assert.equal(manualReconnect.status,200);
    const manualView=(await manualReconnect.json()).server;
    assert.equal(manualView.status,'connected');
    assert.equal(refreshes,1);
    const manualPersisted=JSON.parse(readFileSync(join(${JSON.stringify(scratch)},'.dsh','mcp-manager.json'))).servers.find(s=>s.id===manualId);
    assert.equal(manualPersisted.oauth.tokens.refresh_token,'synthetic-rotated-refresh');
    assert.equal(manualPersisted.oauth.clientId,undefined);
    assert.ok(owned.agent.ctx.tools.schemas(owned.agent).some(t=>t.name==='mcp__manual_oauth__echo'));
    writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:true,dsh:'0.2.1-rc.2',registration:{application_type:'native',requests:registrations},pkce:'S256',exchanges,status:view.status,tool:'mcp__local_oauth__echo',initialized:true,persisted:true,reusedClient:true,manualClient:{refreshes,status:manualView.status,rotated:true}}));
  } catch(error) { writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:false,error:error.stack})); }
  finally { await owned?.dispose();server.closeAllConnections();await new Promise(r=>server.close(r)); }
 })();
}
`);
const patch = join(scratch, 'smoke.yml');
writeFileSync(patch, `- insert:\n    - id: issue21-manager\n      name: ${JSON.stringify(host)}\n    - id: issue21-verifier\n      name: ${JSON.stringify(verifier)}\n`);
let output = '';
const child = spawn(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], {
  cwd: workspace,
  env: { ...process.env, HOME: scratch, USERPROFILE: scratch, DSH_HOME: join(scratch, '.dsh'), PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', c => output += c);
child.stderr.on('data', c => output += c);
const exit = new Promise(r => child.once('exit', r));
try {
  const end = Date.now() + 60000;
  while (!existsSync(resultPath) && Date.now() < end && child.exitCode === null) await new Promise(r => setTimeout(r, 100));
  output = output.replace(/([?&]token=)[^&\s]+/g, '$1<redacted>');
  assert.ok(existsSync(resultPath), `DSH smoke did not complete: ${output}`);
  const result = JSON.parse(readFileSync(resultPath));
  assert.equal(result.ok, true, `${result.error}\n${output}`);
  console.log(JSON.stringify(result));
} finally {
  child.kill('SIGTERM');
  await Promise.race([exit, new Promise(r => setTimeout(r, 3000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
  rmSync(scratch, { recursive: true, force: true });
}
