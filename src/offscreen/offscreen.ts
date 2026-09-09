import { bundle } from '../export/bundle';
const urls = new Set<string>();
let pending = 0;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background/service-worker.js')) return;
  if (message.type === 'REVOKE') { if (urls.delete(message.url)) URL.revokeObjectURL(message.url); respond({ ok: true, empty: urls.size === 0 && pending === 0 }); return; }
  if (message.type !== 'BUNDLE' || !['md','txt','json','zip'].includes(message.format)) return;
  pending++;
  void bundle(message.jobId, message.format).then(({ blob, name }) => {
    const url = URL.createObjectURL(blob); urls.add(url); pending--; respond({ ok: true, url, name });
  }).catch(e => { pending--; respond({ ok: false, error: e.message }); });
  return true;
});
