#!/usr/bin/env node
/** Browser replay: real DSH 0.2 Chat assembly/grouping + the built React image UI.
 * No DSH process, stored credentials, user sessions or paid image calls are used.
 * Optional --before-client <bundle> enables /before for an old/new comparison.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

import { chatSource, conversationSource } from '../tests/image-conversation-fixture.mjs'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const beforeAt = args.indexOf('--before-client')
const beforePath = beforeAt < 0 ? undefined : args[beforeAt + 1]
const png = await readFile(new URL('../docs/assets/dsh-packycode-mascot.png', import.meta.url))
const attachment = { attachmentId: `sha256:${createHash('sha256').update(png).digest('hex')}`, mediaType: 'image/png', bytes: png.length,
  width: png.readUInt32BE(16), height: png.readUInt32BE(20), name: 'saved-image-fixture.png' }
const image = { type: 'image', attachment }
const record = (seq, type, data) => ({ type: 'event', event: { seq, type, data } })
const records = [
  record(1, 'turn/start', { turn: 1 }), record(2, 'step/start', { turn: 1, step: 1 }),
  record(3, 'tool/result', { meta: { kind: 'packycode-image' }, message: { content: [{ type: 'tool-result', toolCallId: 'native-image', content: [image] }] } }),
  record(4, 'step/end', { turn: 1, step: 1 }), record(5, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
  record(6, 'turn/start', { turn: 2 }), record(7, 'step/start', { turn: 2, step: 1 }),
  record(8, 'tool/ptc-dispatch', { rootCallId: 'ptc-root', parentCallId: 'ptc-root', subCallId: 'ptc-image', name: 'packycode_image_generate', isError: false, content: [image] }),
  record(9, 'step/end', { turn: 2, step: 1 }), record(10, 'turn/end', { turn: 2, reason: { kind: 'stop' } }),
]
const nativeRuntime = `const _deepseek_ai_dsh_client_store={notifySubscribers: ls=>{for(const fn of ls)fn()}}; const brandString=x=>x;
window.NativeConversation=(()=>{${conversationSource()}\nreturn ConversationNodeAssembler})();
window.NativeChat=(()=>{${chatSource()}\nreturn {view:chatViewDefinition,groups:processGroupDefinition}})();`
const html = before => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH 图片回放验证</title>
<style>body{margin:0;background:#151515;color:#eee;font:16px system-ui}main{max-width:760px;margin:32px auto;padding:0 24px}button{cursor:pointer;background:#333;color:#eee;border:1px solid #555;border-radius:8px;padding:10px;margin:0 10px 20px 0}h1{font-size:22px}.pkc-generated-image{display:block;padding:0;overflow:hidden}.pkc-generated-image img{display:block;max-width:100%;max-height:360px}.pkc-image-result{padding:16px 0;border-top:1px solid #444}.pkc-status{margin-bottom:12px}.pkc-meta{margin-left:10px;color:#aaa}#status{padding:14px;border:1px solid #555;border-radius:8px;margin-bottom:20px}[data-verdict=PASS]{color:#8dde9b}[data-verdict=FAIL]{color:#f99}[hidden]{display:none!important}</style>
<div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/jsx-runtime.js"></script>
<script>const slots=new Map();let plugin,definition,copy={};const createElement=React.createElement;
window.__ModuleLoader__={load:spec=>{plugin=spec.factory(name=>name==='react'?React:NativeJsxRuntime)}};</script>
<script src="${before ? '/before-client.js' : '/client.js'}"></script><script src="/runtime.js"></script>
<script>
const ref=${JSON.stringify(attachment)};
const frames=${JSON.stringify(records)};
const conversation={events:{register:value=>{definition=value}},imageUrl:async(session,image)=>{
if(session!=='preview-session'||image.attachmentId!==ref.attachmentId)throw Error('wrong image owner');return '/fixture.png'}};
const ctx={locale:{register:(_ns,value)=>{copy=value.zh},bind:()=>key=>copy[key]??key},effect:fn=>fn(),get:name=>({uiConversation:conversation,connection:{rpc:{call:()=>{throw Error('No paid/network RPC allowed')}}}})[name],
inject(names,fn){if(names.length===1&&names[0]==='uiConversation')fn(ctx)},slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>slots.set(spec.name+':'+(spec.key??spec.id),{spec,component})}};
plugin.apply(ctx);
function replay(){const runtime=new NativeConversation({entries:()=>[definition],fallbackEntry:()=>undefined},{entries:()=>[NativeChat.view]},{forTarget:target=>target==='chat'?NativeChat.groups:undefined});runtime.activateTarget('chat');runtime.replaceWindow(JSON.parse(JSON.stringify(frames)),false);runtime.flush();const state=runtime.snapshot('chat');return state.order.map(key=>state.nodes.get(key))}
const gallery=slots.get('conversation.chat.node:packycode-image-output');
const details=slots.get('tool.call.toolview:packycode_image_generate');
function App(){const [open,setOpen]=React.useState(false);const [round,setRound]=React.useState(0);const nodes=React.useMemo(replay,[round]);const props=React.useMemo(()=>gallery.spec.inject('preview-session'),[]);
return createElement('main',null,createElement('h1',null,${JSON.stringify(before ? '1.2.1 原始构建 · 原始事件回放' : '修复构建 · 原始事件回放')}),
createElement('p',null,'DSH 0.2.0-rc.2 组装器和 Chat 分组；原生/PTC 图片事件均不添加 data.turn。'),
createElement('div',{id:'status','data-verdict':nodes.length===2?'PASS':'FAIL'},'主聊天 '+nodes.length+' 张图片 · 工具详情'+(open?'已展开':'已收起')+' · 历史重载 '+round+' 次'),
createElement('button',{onClick:()=>setOpen(!open)},open?'收起工具详情':'展开工具详情'),createElement('button',{onClick:()=>setRound(round+1)},'重新载入历史记录'),
createElement('section',{id:'main-images'},...nodes.map(node=>createElement(gallery.component,{...props,node,key:node.key}))),
createElement('section',{id:'tool-details',hidden:!open},createElement('h2',null,'工具详情中的同一图片'),createElement(details.component,{...props,block:{kind:'tool-result',content:[{type:'image',attachment:ref}]}})))}
ReactDOM.createRoot(document.getElementById('root')).render(createElement(App));
</script></html>`
const reactRoot = dirname(require.resolve('react/package.json'))
const domRoot = dirname(require.resolve('react-dom/package.json'))
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    res.setHeader('cache-control', 'no-store')
    if (path === '/' || path === '/after' || path === '/before') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html(path === '/before')); return }
    if (path === '/fixture.png') { res.setHeader('content-type', 'image/png'); res.end(png); return }
    if (path === '/runtime.js') { res.setHeader('content-type', 'text/javascript'); res.end(nativeRuntime); return }
    if (path === '/jsx-runtime.js') {
      const source = await readFile(join(reactRoot, 'cjs/react-jsx-runtime.development.js'), 'utf8')
      res.setHeader('content-type', 'text/javascript')
      res.end(`window.NativeJsxRuntime=(()=>{const process={env:{NODE_ENV:'development'}},module={exports:{}},exports=module.exports,require=()=>window.React;${source}\nreturn module.exports})();`)
      return
    }
    const file = path === '/react.js' ? join(reactRoot, 'umd/react.development.js') : path === '/react-dom.js' ? join(domRoot, 'umd/react-dom.development.js')
      : path === '/client.js' ? new URL('../lib/client.js', import.meta.url) : path === '/before-client.js' ? beforePath : undefined
    if (file === undefined) { res.writeHead(404); res.end(); return }
    res.setHeader('content-type', 'text/javascript'); res.end(await readFile(file))
  } catch { res.writeHead(500); res.end('Replay fixture failed') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
console.log(`Image replay fixture: http://127.0.0.1:${server.address().port}/after`)
if (beforePath) console.log(`Published-bundle comparison: http://127.0.0.1:${server.address().port}/before`)
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
