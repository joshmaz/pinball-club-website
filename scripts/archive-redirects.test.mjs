import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import vm from 'node:vm';
async function files(dir) {
 const out=[];
 for(const entry of await readdir(dir,{withFileTypes:true})) {
  const path=dir+'/'+entry.name;
  if(entry.isDirectory()) out.push(...await files(path)); else out.push(path);
 }
 return out;
}
test('all historical museum pages redirect to their archive counterpart and retain query/fragment',async()=>{
 const paths=await files('wix_archive');
 assert.equal(paths.length,12);
 for(const path of paths) {
  assert.ok(path.endsWith('.html'));
  const html=await readFile(path,'utf8');
  const expected=path==='wix_archive/index.html'?'https://archive.snhpinballclub.com/':'https://archive.snhpinballclub.com/'+path.split('/').map(encodeURIComponent).join('/');
  let destination;
  vm.runInNewContext(html.match(/<script>(.*?)<\/script>/s)[1],{location:{search:'?menu=console-arcade',hash:'#games',replace:value=>destination=value}});
  assert.equal(destination,expected+'?menu=console-arcade#games');
  assert.ok(html.includes('href="'+expected+'"'));
  assert.ok(html.includes('http-equiv="refresh"'));
 }
});
