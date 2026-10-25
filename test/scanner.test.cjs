const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanText, validMarkers } = require('../out/scanner.js');
const s = { markers: [{ name: 'TODO', priority: 2 }, { name: 'BUG', priority: 1 }, {name:'MY_TASK',priority:3}], commentPrefixes: ['//', '#'], scanAnywhere: false, caseSensitive: false };
test('finds tasks in recognized comments with positions', () => {
 const t=scanText('const x=1; // TODO: implement\n# BUG - fix now\nconst y=3',s);
 assert.equal(t.length,2);
 assert.deepEqual(t.map(x=>[x.marker,x.line,x.description]), [['TODO',0,'implement'],['BUG',1,'fix now']]);
});
test('does not scan ordinary code without a prefix', () => {
 assert.equal(scanText('TODO: something', s).length,0);
 assert.equal(scanText('TODO: something', {...s,scanAnywhere:true}).length,1);
});
test('case sensitivity and custom markers', () => {
 assert.equal(scanText('// todo: lower\n// MY_TASK: own',s).length,2);
 assert.equal(scanText('// todo: lower', {...s,caseSensitive:true}).length,0);
});
test('validates and de-duplicates markers',()=>{
 assert.deepEqual(validMarkers([{name:'BUG',priority:1},{name:'bug',priority:4},{name:'bad name',priority:2},{name:'OK',priority:10}]), [{name:'BUG',priority:1}]);
});
