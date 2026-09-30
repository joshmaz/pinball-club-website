import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const panelSource = await readFile(new URL('../assets/js/member-games-panel.js', import.meta.url), 'utf8');
const publicSource = await readFile(new URL('../assets/js/games.js', import.meta.url), 'utf8');
function dom() {
  const nodes = new Map();
  function element(tag) {
    return {
      tag, children: [], handlers: {}, value: '', checked: false, disabled: false, hidden: false, textContent: '',
      setAttribute(name, value) { this[name] = value; if (name === 'id') nodes.set(value, this); },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...children) { this.children = children; this.textContent = ''; },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); },
      focus() { this.focused = true; }
    };
  }
  const document = {createElement: element, getElementById: id => nodes.get(id), createTextNode(text) {const node = element('#text'); node.textContent = text; return node;}};
  return {nodes, document, element};
}
function fixture({admin = false, count = 0} = {}) {
  const {nodes, document, element} = dom();
  for (const id of ['mg-pg-add','mg-pg-cancel','mg-pg-desc','mg-pg-type','mg-pg-val','mg-pg-notes','mg-pg-preferred','mg-pingolf-target-list','mg-pingolf-help','status']) {
    element('input').setAttribute('id', id);
  }
  let rows = Array.from({length:count}, (_,i) => ({id:`target-${i}`, description:`Target ${i}`,targetType:'feature',isPreferred:i === 0,scoreThreshold:null,notes:null}));
  const writes = [];
  const portal = {
    memberHasAnyRole: () => admin,
    getFriendlyAuthErrorMessage: e => e.message,
    pingolfTargetsListEditor: async () => rows,
    pingolfTargetUpsert: async (id, game, fields) => {
      writes.push({id,game,fields});
      if (fields.isPreferred) rows.forEach(row => {row.isPreferred = false;});
      if (id) Object.assign(rows.find(row => row.id === id), fields);
      else rows.push({id:'new',...fields});
    },
    pingolfTargetDelete: async id => { writes.push({deleted:id}); rows = rows.filter(row => row.id !== id); }
  };
  const context = {window:{SNHMemberPortal:portal},document,confirm:()=>true,console};
  const expose = `window.test = {loadPingolfTargetsForGame, onAddPingolfTarget, onDeletePingolfTarget, resetPingolfForm,
    switchGame(id) { currentGameId=id; pingolfLoaded=false; resetPingolfForm(); },
    get busy() { return pingolfBusy; }};
    currentGameId='game-1'; statusEl=document.getElementById('status');`;
  vm.runInNewContext(panelSource.replace('  window.SNHMemberGamesPanel = {', expose+'\n  window.SNHMemberGamesPanel = {'), context);
  return {api:context.window.test,nodes,portal,writes,get rows(){return rows;}};
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('editor limit still permits editing, retains exact score, cancels edit, and hides admin deletion', async () => {
  const f = fixture({count:10});
  await f.api.loadPingolfTargetsForGame('game-1');
  assert.equal(f.nodes.get('mg-pg-add').disabled,true);
  assert.match(f.nodes.get('mg-pingolf-help').textContent,/10 of 10/);
  const row = f.nodes.get('mg-pingolf-target-list').children[0];
  assert.deepEqual(row.children.slice(1).map(n => n.textContent),['Edit','Clear preferred']);
  row.children[1].handlers.click();
  assert.equal(f.nodes.get('mg-pg-add').disabled,false);
  assert.equal(f.nodes.get('mg-pg-add').textContent,'Save target');
  f.nodes.get('mg-pg-val').value='9223372036854775807';
  f.nodes.get('mg-pg-type').value='hybrid';
  await f.api.onAddPingolfTarget();
  assert.equal(f.writes[0].id,'target-0');
  assert.equal(f.writes[0].fields.scoreThreshold,'9223372036854775807');
  assert.equal(f.nodes.get('mg-pg-add').disabled,true);
  f.nodes.get('mg-pingolf-target-list').children[1].children[1].handlers.click();
  f.api.resetPingolfForm();
  assert.equal(f.nodes.get('mg-pg-desc').value,'');
  assert.equal(f.nodes.get('mg-pg-add').disabled,true);
});

test('create validation, preferred controls, and admin deletion call the game-oriented API', async () => {
  const f = fixture({admin:true,count:1});
  await f.api.loadPingolfTargetsForGame('game-1');
  f.api.resetPingolfForm();
  f.nodes.get('mg-pg-desc').value='Reach a big score';
  f.nodes.get('mg-pg-type').value='score';
  for (const bad of ['1.5','-1','0','9223372036854775808']) {
    f.nodes.get('mg-pg-val').value=bad;
    await f.api.onAddPingolfTarget();
  }
  assert.equal(f.writes.length,0);
  f.nodes.get('mg-pg-val').value='5000000000';
  f.nodes.get('mg-pg-preferred').checked=true;
  await f.api.onAddPingolfTarget();
  assert.equal(f.writes[0].id,null);
  assert.equal(f.writes[0].game,'game-1');
  assert.equal(f.writes[0].fields.scoreThreshold,'5000000000');
  f.nodes.get('mg-pingolf-target-list').children[1].children[2].handlers.click();
  await flush();
  assert.equal(f.rows.filter(r=>r.isPreferred).length,0);
  await f.api.onDeletePingolfTarget('new');
  assert.equal(f.rows.length,1);
});

test('pending writes cannot double-submit and stale reads do not populate another game', async () => {
  const f = fixture();
  await f.api.loadPingolfTargetsForGame('game-1');
  f.api.resetPingolfForm();
  f.nodes.get('mg-pg-desc').value='Start multiball';
  let resolveWrite;
  let calls=0;
  f.portal.pingolfTargetUpsert=()=>{calls++; return new Promise(resolve=>{resolveWrite=resolve;});};
  const pending=f.api.onAddPingolfTarget();
  assert.equal(f.nodes.get('mg-pg-add').disabled,true);
  await f.api.onAddPingolfTarget();
  assert.equal(calls,1);
  resolveWrite(); await pending;
  let resolveRead;
  f.portal.pingolfTargetsListEditor=()=>new Promise(resolve=>{resolveRead=resolve;});
  const load=f.api.loadPingolfTargetsForGame('game-1');
  f.api.switchGame('game-2');
  resolveRead([{id:'stale',description:'Wrong game'}]); await load;
  assert.equal(f.nodes.get('mg-pingolf-target-list').children.length,0);
  assert.equal(f.nodes.get('mg-pg-add').disabled,true);
});

test('public targets put preferred first, render descriptions safely, and omit empty sections', () => {
  const {document,element}=dom();
  const start=publicSource.indexOf('function renderGameMoreInfoSections(');
  const end=publicSource.indexOf('\nfunction ',start+1);
  const context={document,hasNonemptyString:value=>typeof value==='string' && value.trim().length>0};
  vm.runInNewContext(publicSource.slice(start,end),context);
  const body=element('div');
  context.renderGameMoreInfoSections({pingolfTargets:[{description:'Other',targetType:'feature'},{description:'<img src=x onerror=alert(1)>',targetType:'score',isPreferred:true}]},body,'play');
  assert.equal(body.children[0].children[0].textContent,'Pingolf Targets');
  const preferred=body.children[0].children[1].children[0];
  assert.equal(preferred.children[0].tag,'strong');
  assert.equal(preferred.children[1].tag,'#text');
  assert.match(preferred.children[1].textContent,/<img/);
  const empty=element('div');
  context.renderGameMoreInfoSections({pingolfTargets:[]},empty,'play');
  assert.ok(!empty.children.some(n=>n.tag==='section'));
});
